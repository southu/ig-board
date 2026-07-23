// Threaded comments — polymorphic target, replies, resolve/unresolve, auth.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { buildApp } from '../src/server.js';
import {
  resetCommentsStore,
  commentCount,
  createComment,
  listComments
} from '../src/commentsStore.js';

const SECRET = 'comments-test-jwt-secret';
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

function roleToken(role, email) {
  return signJwt({
    sub: `user-${role}`,
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

test('store: exactly one target required; reply inherits parent target', () => {
  resetCommentsStore();
  assert.throws(
    () => createComment({ body: 'x', authorId: 'u1' }),
    (err) => err && err.code === 'VALIDATION'
  );
  assert.throws(
    () =>
      createComment({
        body: 'x',
        authorId: 'u1',
        kpiId: 'k1',
        memoId: 'm1'
      }),
    (err) => err && err.code === 'VALIDATION'
  );

  const root = createComment({
    body: 'Root on KPI @alice',
    authorId: 'u1',
    authorEmail: 'a@b.co',
    kpiId: 'revenue_plan_fy1'
  });
  assert.equal(root.kpi_id, 'revenue_plan_fy1');
  assert.equal(root.memo_id, null);
  assert.equal(root.analysis_id, null);
  assert.equal(root.parent_id, null);
  assert.equal(root.resolved, false);

  const child = createComment({
    body: 'Reply',
    authorId: 'u2',
    parentId: root.id
  });
  assert.equal(child.parent_id, root.id);
  assert.equal(child.kpi_id, 'revenue_plan_fy1');
  assert.equal(listComments({ kpiId: 'revenue_plan_fy1' }).length, 2);
  assert.equal(commentCount(), 2);
});

test('POST /api/comments without auth returns 401', async (t) => {
  const app = await makeApp();
  t.after(() => {
    app._restoreSecret();
    return app.close();
  });
  const res = await app.inject({
    method: 'POST',
    url: '/api/comments',
    payload: { body: 'hello', kpi_id: 'revenue_plan_fy1' }
  });
  assert.equal(res.statusCode, 401);
  assert.equal(commentCount(), 0);
});

test('board can create KPI comment; thread persists; reply has parent_id', async (t) => {
  const app = await makeApp();
  t.after(() => {
    app._restoreSecret();
    return app.close();
  });
  const token = roleToken('board');

  const create = await app.inject({
    method: 'POST',
    url: '/api/comments',
    headers: { authorization: `Bearer ${token}` },
    payload: {
      body: 'Looks soft vs plan @cfo',
      kpi_id: 'revenue_plan_fy1'
    }
  });
  assert.equal(create.statusCode, 201);
  const root = create.json().comment;
  assert.ok(root.id);
  assert.equal(root.kpi_id, 'revenue_plan_fy1');
  assert.equal(root.parent_id, null);
  assert.equal(root.resolved, false);
  assert.match(root.body, /@cfo/);

  const reply = await app.inject({
    method: 'POST',
    url: '/api/comments',
    headers: { authorization: `Bearer ${token}` },
    payload: {
      body: 'Agree — watch Q3.',
      parent_id: root.id
    }
  });
  assert.equal(reply.statusCode, 201);
  const child = reply.json().comment;
  assert.equal(child.parent_id, root.id);
  assert.equal(child.kpi_id, 'revenue_plan_fy1');

  const list = await app.inject({
    method: 'GET',
    url: '/api/comments?kpi_id=revenue_plan_fy1',
    headers: { authorization: `Bearer ${token}` }
  });
  assert.equal(list.statusCode, 200);
  const comments = list.json().comments;
  assert.equal(comments.length, 2);
  assert.ok(comments.some((c) => c.id === root.id));
  assert.ok(comments.some((c) => c.parent_id === root.id));
});

test('resolve then unresolve persists', async (t) => {
  const app = await makeApp();
  t.after(() => {
    app._restoreSecret();
    return app.close();
  });
  const token = roleToken('founder');

  const create = await app.inject({
    method: 'POST',
    url: '/api/comments',
    headers: { authorization: `Bearer ${token}` },
    payload: { body: 'Close this after review', kpi_id: 'gross_margin_pct' }
  });
  const id = create.json().comment.id;

  const resolved = await app.inject({
    method: 'PATCH',
    url: `/api/comments/${id}`,
    headers: { authorization: `Bearer ${token}` },
    payload: { resolved: true }
  });
  assert.equal(resolved.statusCode, 200);
  assert.equal(resolved.json().comment.resolved, true);

  const again = await app.inject({
    method: 'GET',
    url: '/api/comments?kpi_id=gross_margin_pct',
    headers: { authorization: `Bearer ${token}` }
  });
  assert.equal(again.json().comments[0].resolved, true);

  const open = await app.inject({
    method: 'PATCH',
    url: `/api/comments/${id}`,
    headers: { authorization: `Bearer ${token}` },
    payload: { resolved: false }
  });
  assert.equal(open.statusCode, 200);
  assert.equal(open.json().comment.resolved, false);
});

test('comments attach to memo_id and analysis_id', async (t) => {
  const app = await makeApp();
  t.after(() => {
    app._restoreSecret();
    return app.close();
  });
  const token = roleToken('board');

  const memo = await app.inject({
    method: 'POST',
    url: '/api/comments',
    headers: { authorization: `Bearer ${token}` },
    payload: { body: 'Memo note @founder', memo_id: 'memo-demo-1' }
  });
  assert.equal(memo.statusCode, 201);
  assert.equal(memo.json().comment.memo_id, 'memo-demo-1');
  assert.equal(memo.json().comment.kpi_id, null);
  assert.equal(memo.json().comment.analysis_id, null);

  const analysis = await app.inject({
    method: 'POST',
    url: '/api/comments',
    headers: { authorization: `Bearer ${token}` },
    payload: {
      body: 'Analysis thread @board',
      analysis_id: 'independent-analysis'
    }
  });
  assert.equal(analysis.statusCode, 201);
  assert.equal(analysis.json().comment.analysis_id, 'independent-analysis');
  assert.equal(analysis.json().comment.memo_id, null);

  const memoList = await app.inject({
    method: 'GET',
    url: '/api/comments?memo_id=memo-demo-1',
    headers: { authorization: `Bearer ${token}` }
  });
  assert.equal(memoList.json().comments.length, 1);

  const analysisList = await app.inject({
    method: 'GET',
    url: '/api/comments?analysis_id=independent-analysis',
    headers: { authorization: `Bearer ${token}` }
  });
  assert.equal(analysisList.json().comments.length, 1);
});

test('GET /api/comments rejects multi-target and unauthenticated', async (t) => {
  const app = await makeApp();
  t.after(() => {
    app._restoreSecret();
    return app.close();
  });
  const noAuth = await app.inject({
    method: 'GET',
    url: '/api/comments?kpi_id=x'
  });
  assert.equal(noAuth.statusCode, 401);

  const token = roleToken('board');
  const bad = await app.inject({
    method: 'GET',
    url: '/api/comments?kpi_id=a&memo_id=b',
    headers: { authorization: `Bearer ${token}` }
  });
  assert.equal(bad.statusCode, 400);
});
