// Comment reactions — set/switch/toggle-off, counts, per-user isolation.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { buildApp } from '../src/server.js';
import {
  resetCommentsStore,
  createComment,
  setReaction,
  clearReaction,
  getUserReaction,
  reactionCount,
  listComments
} from '../src/commentsStore.js';

const SECRET = 'reactions-test-jwt-secret';
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

function findComment(comments, id) {
  return (comments || []).find((c) => c.id === id);
}

// ---------------------------------------------------------------------------
// Store unit tests
// ---------------------------------------------------------------------------

test('store: toggle-off — same type posted twice clears the reaction', () => {
  resetCommentsStore();
  const c = createComment({
    body: 'Toggle me',
    authorId: 'u1',
    kpiId: 'bypass_count'
  });

  const set = setReaction({ commentId: c.id, userId: 'u1', type: 'like' });
  assert.equal(set.action, 'set');
  assert.equal(set.reaction_type, 'like');
  assert.equal(getUserReaction(c.id, 'u1'), 'like');
  assert.equal(set.comment.reaction_counts.like, 1);
  assert.equal(set.comment.my_reaction, 'like');
  assert.equal(reactionCount(), 1);

  const cleared = setReaction({ commentId: c.id, userId: 'u1', type: 'like' });
  assert.equal(cleared.action, 'cleared');
  assert.equal(cleared.reaction_type, null);
  assert.equal(getUserReaction(c.id, 'u1'), null);
  assert.equal(cleared.comment.reaction_counts.like, 0);
  assert.equal(cleared.comment.my_reaction, null);
  assert.equal(reactionCount(), 0);
});

test('store: switch-between-types — like then dislike leaves exactly one dislike', () => {
  resetCommentsStore();
  const c = createComment({
    body: 'Switch me',
    authorId: 'u1',
    kpiId: 'bypass_count'
  });

  setReaction({ commentId: c.id, userId: 'u1', type: 'like' });
  const switched = setReaction({
    commentId: c.id,
    userId: 'u1',
    type: 'dislike'
  });
  assert.equal(switched.action, 'switched');
  assert.equal(switched.reaction_type, 'dislike');
  assert.equal(getUserReaction(c.id, 'u1'), 'dislike');
  assert.equal(reactionCount(), 1); // uniqueness: still one row
  assert.equal(switched.comment.reaction_counts.like, 0);
  assert.equal(switched.comment.reaction_counts.dislike, 1);
  assert.equal(switched.comment.my_reaction, 'dislike');
});

test('store: per-user isolation — A like never appears as B own reaction', () => {
  resetCommentsStore();
  const c = createComment({
    body: 'Shared thread',
    authorId: 'ua',
    kpiId: 'bypass_count'
  });

  setReaction({ commentId: c.id, userId: 'user-a', type: 'like' });
  setReaction({ commentId: c.id, userId: 'user-b', type: 'question' });

  const asA = listComments({ kpiId: 'bypass_count', viewerUserId: 'user-a' });
  const asB = listComments({ kpiId: 'bypass_count', viewerUserId: 'user-b' });
  assert.equal(asA[0].reaction_counts.like, 1);
  assert.equal(asA[0].reaction_counts.question, 1);
  assert.equal(asA[0].my_reaction, 'like');
  assert.equal(asB[0].reaction_counts.like, 1); // aggregate includes A
  assert.equal(asB[0].reaction_counts.question, 1);
  assert.equal(asB[0].my_reaction, 'question'); // not A's like

  clearReaction({ commentId: c.id, userId: 'user-b' });
  const asB2 = listComments({ kpiId: 'bypass_count', viewerUserId: 'user-b' });
  assert.equal(asB2[0].my_reaction, null);
  assert.equal(asB2[0].reaction_counts.like, 1);
  assert.equal(asB2[0].reaction_counts.question, 0);
});

// ---------------------------------------------------------------------------
// HTTP integration tests
// ---------------------------------------------------------------------------

test('POST /api/comments/:id/reactions without auth returns 401 and creates nothing', async (t) => {
  const app = await makeApp();
  t.after(() => {
    app._restoreSecret();
    return app.close();
  });

  const c = createComment({
    body: 'Auth gate',
    authorId: 'u1',
    kpiId: 'bypass_count'
  });

  const res = await app.inject({
    method: 'POST',
    url: `/api/comments/${c.id}/reactions`,
    payload: { type: 'like' }
  });
  assert.equal(res.statusCode, 401);
  assert.equal(reactionCount(), 0);

  const del = await app.inject({
    method: 'DELETE',
    url: `/api/comments/${c.id}/reactions`
  });
  assert.equal(del.statusCode, 401);
});

test('HTTP: set like, switch to dislike, toggle-off, question, explicit delete', async (t) => {
  const app = await makeApp();
  t.after(() => {
    app._restoreSecret();
    return app.close();
  });
  const token = roleToken('board', { sub: 'user-alice' });
  const kpi = 'bypass_count';

  const created = await app.inject({
    method: 'POST',
    url: '/api/comments',
    headers: { authorization: `Bearer ${token}` },
    payload: { body: 'React to this', kpi_id: kpi }
  });
  assert.equal(created.statusCode, 201);
  const commentId = created.json().comment.id;

  // 1) Set like
  const like = await app.inject({
    method: 'POST',
    url: `/api/comments/${commentId}/reactions`,
    headers: { authorization: `Bearer ${token}` },
    payload: { type: 'like' }
  });
  assert.equal(like.statusCode, 200);
  assert.equal(like.json().action, 'set');
  assert.equal(like.json().my_reaction, 'like');
  assert.equal(like.json().comment.reaction_counts.like, 1);
  assert.equal(like.json().comment.my_reaction, 'like');

  let list = await app.inject({
    method: 'GET',
    url: `/api/comments?kpi_id=${kpi}`,
    headers: { authorization: `Bearer ${token}` }
  });
  assert.equal(list.statusCode, 200);
  let row = findComment(list.json().comments, commentId);
  assert.equal(row.reaction_counts.like, 1);
  assert.equal(row.reaction_counts.dislike, 0);
  assert.equal(row.my_reaction, 'like');

  // 2) Switch to dislike
  const dislike = await app.inject({
    method: 'POST',
    url: `/api/comments/${commentId}/reactions`,
    headers: { authorization: `Bearer ${token}` },
    payload: { reaction_type: 'dislike' }
  });
  assert.equal(dislike.statusCode, 200);
  assert.equal(dislike.json().action, 'switched');
  assert.equal(dislike.json().my_reaction, 'dislike');

  list = await app.inject({
    method: 'GET',
    url: `/api/comments?kpi_id=${kpi}`,
    headers: { authorization: `Bearer ${token}` }
  });
  row = findComment(list.json().comments, commentId);
  assert.equal(row.reaction_counts.like, 0);
  assert.equal(row.reaction_counts.dislike, 1);
  assert.equal(row.my_reaction, 'dislike');
  assert.equal(reactionCount(), 1);

  // 3) Toggle-off (same type again)
  const toggle = await app.inject({
    method: 'POST',
    url: `/api/comments/${commentId}/reactions`,
    headers: { authorization: `Bearer ${token}` },
    payload: { type: 'dislike' }
  });
  assert.equal(toggle.statusCode, 200);
  assert.equal(toggle.json().action, 'cleared');
  assert.equal(toggle.json().my_reaction, null);

  list = await app.inject({
    method: 'GET',
    url: `/api/comments?kpi_id=${kpi}`,
    headers: { authorization: `Bearer ${token}` }
  });
  row = findComment(list.json().comments, commentId);
  assert.equal(row.reaction_counts.dislike, 0);
  assert.equal(row.my_reaction, null);

  // 4) Question works as a distinct type
  const q = await app.inject({
    method: 'POST',
    url: `/api/comments/${commentId}/reactions`,
    headers: { authorization: `Bearer ${token}` },
    payload: { reaction: 'question' }
  });
  assert.equal(q.statusCode, 200);
  assert.equal(q.json().my_reaction, 'question');
  assert.equal(q.json().comment.reaction_counts.question, 1);

  // 5) Explicit DELETE clears
  const del = await app.inject({
    method: 'DELETE',
    url: `/api/comments/${commentId}/reactions`,
    headers: { authorization: `Bearer ${token}` }
  });
  assert.equal(del.statusCode, 200);
  assert.equal(del.json().my_reaction, null);
  assert.equal(del.json().comment.reaction_counts.question, 0);
});

test('HTTP: per-user isolation — aggregate counts, own reaction is personal', async (t) => {
  const app = await makeApp();
  t.after(() => {
    app._restoreSecret();
    return app.close();
  });

  const tokenA = roleToken('board', {
    sub: 'user-a',
    email: 'a@boardroom.test'
  });
  const tokenB = roleToken('founder', {
    sub: 'user-b',
    email: 'b@boardroom.test'
  });
  const kpi = 'founder_intervention_count';

  const created = await app.inject({
    method: 'POST',
    url: '/api/comments',
    headers: { authorization: `Bearer ${tokenA}` },
    payload: { body: 'Isolation check', kpi_id: kpi }
  });
  const commentId = created.json().comment.id;

  await app.inject({
    method: 'POST',
    url: `/api/comments/${commentId}/reactions`,
    headers: { authorization: `Bearer ${tokenA}` },
    payload: { type: 'like' }
  });

  // User B sees aggregate like count, but my_reaction is null
  const listB = await app.inject({
    method: 'GET',
    url: `/api/comments?kpi_id=${kpi}`,
    headers: { authorization: `Bearer ${tokenB}` }
  });
  assert.equal(listB.statusCode, 200);
  const asB = findComment(listB.json().comments, commentId);
  assert.equal(asB.reaction_counts.like, 1);
  assert.equal(asB.my_reaction, null);

  // User A still sees own reaction as like
  const listA = await app.inject({
    method: 'GET',
    url: `/api/comments?kpi_id=${kpi}`,
    headers: { authorization: `Bearer ${tokenA}` }
  });
  const asA = findComment(listA.json().comments, commentId);
  assert.equal(asA.reaction_counts.like, 1);
  assert.equal(asA.my_reaction, 'like');

  // B reacts with dislike — counts accumulate; each user sees own type
  await app.inject({
    method: 'POST',
    url: `/api/comments/${commentId}/reactions`,
    headers: { authorization: `Bearer ${tokenB}` },
    payload: { type: 'dislike' }
  });

  const listA2 = await app.inject({
    method: 'GET',
    url: `/api/comments?kpi_id=${kpi}`,
    headers: { authorization: `Bearer ${tokenA}` }
  });
  const a2 = findComment(listA2.json().comments, commentId);
  assert.equal(a2.reaction_counts.like, 1);
  assert.equal(a2.reaction_counts.dislike, 1);
  assert.equal(a2.my_reaction, 'like');

  const listB2 = await app.inject({
    method: 'GET',
    url: `/api/comments?kpi_id=${kpi}`,
    headers: { authorization: `Bearer ${tokenB}` }
  });
  const b2 = findComment(listB2.json().comments, commentId);
  assert.equal(b2.reaction_counts.like, 1);
  assert.equal(b2.reaction_counts.dislike, 1);
  assert.equal(b2.my_reaction, 'dislike');
});

test('HTTP: invalid reaction type and missing comment return 400/404', async (t) => {
  const app = await makeApp();
  t.after(() => {
    app._restoreSecret();
    return app.close();
  });
  const token = roleToken('board');

  const c = createComment({
    body: 'x',
    authorId: 'u1',
    kpiId: 'bypass_count'
  });

  const bad = await app.inject({
    method: 'POST',
    url: `/api/comments/${c.id}/reactions`,
    headers: { authorization: `Bearer ${token}` },
    payload: { type: 'love' }
  });
  assert.equal(bad.statusCode, 400);

  const missing = await app.inject({
    method: 'POST',
    url: '/api/comments/does-not-exist/reactions',
    headers: { authorization: `Bearer ${token}` },
    payload: { type: 'like' }
  });
  assert.equal(missing.statusCode, 404);
});
