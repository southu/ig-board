// Soft-delete comments — authorization paths + list exclusion + reaction totals.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { buildApp } from '../src/server.js';
import {
  resetCommentsStore,
  createComment,
  listComments,
  getComment,
  getCommentRow,
  softDeleteComment,
  setReaction,
  reactionSummaryForComment,
  commentCount
} from '../src/commentsStore.js';

const SECRET = 'comment-delete-test-jwt-secret';
const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
const now = () => Math.floor(Date.now() / 1000);

function signJwt(payload, secret = SECRET) {
  const header = b64({ alg: 'HS256', typ: 'JWT' });
  const body = b64(payload);
  const sig = crypto
    .createHmac('sha256', secret)
    .update(`${header}.${body}`)
    .digest('base64url');
  return `${header}.${body}.${sig}`;
}

function roleToken(role, { sub, email } = {}) {
  return signJwt({
    sub: sub || `user-${role}`,
    email: email || `${role}.e2e@boardroom.test`,
    aud: 'authenticated',
    role: 'authenticated',
    app_metadata: { role },
    exp: now() + 3600
  });
}

async function makeApp() {
  const prev = process.env.SUPABASE_JWT_SECRET;
  process.env.SUPABASE_JWT_SECRET = SECRET;
  resetCommentsStore();
  const app = buildApp({ logger: false });
  await app.ready();
  app._restoreSecret = () => {
    if (prev === undefined) delete process.env.SUPABASE_JWT_SECRET;
    else process.env.SUPABASE_JWT_SECRET = prev;
  };
  return app;
}

// ---------------------------------------------------------------------------
// Store unit tests
// ---------------------------------------------------------------------------

test('store: soft-delete sets deleted_at/deleted_by and excludes from lists', () => {
  resetCommentsStore();
  const a = createComment({
    body: 'keep me',
    authorId: 'author-1',
    kpiId: 'bypass_count'
  });
  const b = createComment({
    body: 'delete me',
    authorId: 'author-1',
    kpiId: 'bypass_count'
  });
  assert.equal(listComments({ kpiId: 'bypass_count' }).length, 2);

  const result = softDeleteComment({ id: b.id, deletedBy: 'author-1' });
  assert.equal(result.ok, true);
  assert.ok(result.deleted_at);
  assert.equal(result.deleted_by, 'author-1');

  // Row still present (never hard-deleted).
  assert.equal(commentCount(), 2);
  const raw = getCommentRow(b.id);
  assert.ok(raw.deleted_at);
  assert.equal(raw.deleted_by, 'author-1');

  // Public get + list exclude soft-deleted.
  assert.equal(getComment(b.id), null);
  const listed = listComments({ kpiId: 'bypass_count' });
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, a.id);
  assert.equal(listed[0].body, 'keep me');
});

test('store: soft-deleted comment reactions do not count', () => {
  resetCommentsStore();
  const c = createComment({
    body: 'react then delete',
    authorId: 'u1',
    kpiId: 'bypass_count'
  });
  setReaction({ commentId: c.id, userId: 'u1', type: 'like' });
  setReaction({ commentId: c.id, userId: 'u2', type: 'dislike' });
  assert.equal(reactionSummaryForComment(c.id, 'u1').reaction_counts.like, 1);
  assert.equal(reactionSummaryForComment(c.id, 'u1').reaction_counts.dislike, 1);

  softDeleteComment({ id: c.id, deletedBy: 'u1' });
  const summary = reactionSummaryForComment(c.id, 'u1');
  assert.deepEqual(summary.reaction_counts, {
    like: 0,
    dislike: 0,
    question: 0
  });
  assert.equal(summary.my_reaction, null);
  assert.equal(listComments({ kpiId: 'bypass_count' }).length, 0);
});

// ---------------------------------------------------------------------------
// HTTP authorization paths (mission-required)
// ---------------------------------------------------------------------------

test('author can delete own comment (success) and it leaves the list', async (t) => {
  const app = await makeApp();
  t.after(() => {
    app._restoreSecret();
    return app.close();
  });

  const authorToken = roleToken('board', {
    sub: 'user-author',
    email: 'author@boardroom.test'
  });
  const kpi = 'bypass_count';

  const created = await app.inject({
    method: 'POST',
    url: '/api/comments',
    headers: { authorization: `Bearer ${authorToken}` },
    payload: { body: 'my own comment', kpi_id: kpi }
  });
  assert.equal(created.statusCode, 201);
  const commentId = created.json().comment.id;
  assert.equal(created.json().comment.author_id, 'user-author');

  const del = await app.inject({
    method: 'DELETE',
    url: `/api/comments/${commentId}`,
    headers: { authorization: `Bearer ${authorToken}` }
  });
  assert.equal(del.statusCode, 200);
  assert.equal(del.json().ok, true);
  assert.equal(del.json().deleted, true);
  assert.equal(del.json().id, commentId);

  // Soft-delete only — row retained with deleted_at.
  const raw = getCommentRow(commentId);
  assert.ok(raw);
  assert.ok(raw.deleted_at);
  assert.equal(raw.deleted_by, 'user-author');

  const list = await app.inject({
    method: 'GET',
    url: `/api/comments?kpi_id=${kpi}`,
    headers: { authorization: `Bearer ${authorToken}` }
  });
  assert.equal(list.statusCode, 200);
  assert.equal(list.json().comments.length, 0);
  assert.ok(!list.json().comments.some((c) => c.id === commentId));
});

test('admin can delete another user comment (success)', async (t) => {
  const app = await makeApp();
  t.after(() => {
    app._restoreSecret();
    return app.close();
  });

  const authorToken = roleToken('board', {
    sub: 'user-author',
    email: 'author@boardroom.test'
  });
  const adminToken = roleToken('admin', {
    sub: 'user-admin',
    email: 'admin@boardroom.test'
  });
  const kpi = 'founder_intervention_count';

  const created = await app.inject({
    method: 'POST',
    url: '/api/comments',
    headers: { authorization: `Bearer ${authorToken}` },
    payload: { body: 'board member post', kpi_id: kpi }
  });
  assert.equal(created.statusCode, 201);
  const commentId = created.json().comment.id;

  // Keep a second comment so thread still has content after delete.
  const other = await app.inject({
    method: 'POST',
    url: '/api/comments',
    headers: { authorization: `Bearer ${adminToken}` },
    payload: { body: 'admin stays', kpi_id: kpi }
  });
  assert.equal(other.statusCode, 201);
  const keepId = other.json().comment.id;

  const del = await app.inject({
    method: 'DELETE',
    url: `/api/comments/${commentId}`,
    headers: { authorization: `Bearer ${adminToken}` }
  });
  assert.equal(del.statusCode, 200);
  assert.equal(del.json().deleted, true);

  const list = await app.inject({
    method: 'GET',
    url: `/api/comments?kpi_id=${kpi}`,
    headers: { authorization: `Bearer ${adminToken}` }
  });
  assert.equal(list.statusCode, 200);
  const comments = list.json().comments;
  assert.equal(comments.length, 1);
  assert.equal(comments[0].id, keepId);
  assert.ok(!comments.some((c) => c.id === commentId));
});

test('non-author non-admin user gets 403; comment remains visible', async (t) => {
  const app = await makeApp();
  t.after(() => {
    app._restoreSecret();
    return app.close();
  });

  const authorToken = roleToken('board', {
    sub: 'user-author',
    email: 'author@boardroom.test'
  });
  const otherToken = roleToken('board', {
    sub: 'user-other',
    email: 'other@boardroom.test'
  });
  // executive has input/edit KPI but NOT delete_any_comment
  const execToken = roleToken('executive', {
    sub: 'user-exec',
    email: 'exec@boardroom.test'
  });
  const kpi = 'bypass_count';

  const created = await app.inject({
    method: 'POST',
    url: '/api/comments',
    headers: { authorization: `Bearer ${authorToken}` },
    payload: { body: 'protected comment', kpi_id: kpi }
  });
  assert.equal(created.statusCode, 201);
  const commentId = created.json().comment.id;

  const deniedBoard = await app.inject({
    method: 'DELETE',
    url: `/api/comments/${commentId}`,
    headers: { authorization: `Bearer ${otherToken}` }
  });
  assert.equal(deniedBoard.statusCode, 403);
  assert.equal(deniedBoard.json().error, 'forbidden');

  const deniedExec = await app.inject({
    method: 'DELETE',
    url: `/api/comments/${commentId}`,
    headers: { authorization: `Bearer ${execToken}` }
  });
  assert.equal(deniedExec.statusCode, 403);

  // Comment still listed and not soft-deleted.
  const raw = getCommentRow(commentId);
  assert.equal(raw.deleted_at, null);

  const list = await app.inject({
    method: 'GET',
    url: `/api/comments?kpi_id=${kpi}`,
    headers: { authorization: `Bearer ${otherToken}` }
  });
  assert.equal(list.statusCode, 200);
  assert.equal(list.json().comments.length, 1);
  assert.equal(list.json().comments[0].id, commentId);
});

test('DELETE without auth returns 401', async (t) => {
  const app = await makeApp();
  t.after(() => {
    app._restoreSecret();
    return app.close();
  });

  const c = createComment({
    body: 'x',
    authorId: 'u1',
    kpiId: 'bypass_count'
  });
  const res = await app.inject({
    method: 'DELETE',
    url: `/api/comments/${c.id}`
  });
  assert.equal(res.statusCode, 401);
  assert.equal(getCommentRow(c.id).deleted_at, null);
});

test('legacy founder role can delete any comment (delete_any_comment alias)', async (t) => {
  const app = await makeApp();
  t.after(() => {
    app._restoreSecret();
    return app.close();
  });

  const authorToken = roleToken('board', { sub: 'user-a' });
  const founderToken = roleToken('founder', { sub: 'user-founder' });
  const created = await app.inject({
    method: 'POST',
    url: '/api/comments',
    headers: { authorization: `Bearer ${authorToken}` },
    payload: { body: 'legacy admin path', kpi_id: 'bypass_count' }
  });
  const commentId = created.json().comment.id;

  const del = await app.inject({
    method: 'DELETE',
    url: `/api/comments/${commentId}`,
    headers: { authorization: `Bearer ${founderToken}` }
  });
  assert.equal(del.statusCode, 200);
  assert.equal(del.json().deleted, true);
});

test('HTTP: soft-deleted comment reactions vanish from list totals', async (t) => {
  const app = await makeApp();
  t.after(() => {
    app._restoreSecret();
    return app.close();
  });

  const authorToken = roleToken('board', { sub: 'user-a' });
  const otherToken = roleToken('board', { sub: 'user-b' });
  const kpi = 'bypass_count';

  const keep = await app.inject({
    method: 'POST',
    url: '/api/comments',
    headers: { authorization: `Bearer ${authorToken}` },
    payload: { body: 'stays', kpi_id: kpi }
  });
  const keepId = keep.json().comment.id;

  const doomed = await app.inject({
    method: 'POST',
    url: '/api/comments',
    headers: { authorization: `Bearer ${authorToken}` },
    payload: { body: 'goes away with likes', kpi_id: kpi }
  });
  const doomedId = doomed.json().comment.id;

  await app.inject({
    method: 'POST',
    url: `/api/comments/${doomedId}/reactions`,
    headers: { authorization: `Bearer ${authorToken}` },
    payload: { type: 'like' }
  });
  await app.inject({
    method: 'POST',
    url: `/api/comments/${keepId}/reactions`,
    headers: { authorization: `Bearer ${otherToken}` },
    payload: { type: 'like' }
  });

  let list = await app.inject({
    method: 'GET',
    url: `/api/comments?kpi_id=${kpi}`,
    headers: { authorization: `Bearer ${authorToken}` }
  });
  assert.equal(list.json().comments.length, 2);
  const beforeDoomed = list.json().comments.find((c) => c.id === doomedId);
  assert.equal(beforeDoomed.reaction_counts.like, 1);

  await app.inject({
    method: 'DELETE',
    url: `/api/comments/${doomedId}`,
    headers: { authorization: `Bearer ${authorToken}` }
  });

  list = await app.inject({
    method: 'GET',
    url: `/api/comments?kpi_id=${kpi}`,
    headers: { authorization: `Bearer ${authorToken}` }
  });
  assert.equal(list.json().comments.length, 1);
  assert.equal(list.json().comments[0].id, keepId);
  // Remaining comment still shows its own reaction only (deleted's likes gone).
  assert.equal(list.json().comments[0].reaction_counts.like, 1);
  assert.ok(!list.json().comments.some((c) => c.id === doomedId));
});
