// Integration/route tests: capability guards on KPI write endpoints and session
// exposure. Exercises the real Fastify surface via app.inject().
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { buildApp } from '../src/server.js';
import { resetStore } from '../src/store.js';
import { CAPABILITIES } from '../src/permissions.js';

const SECRET = 'permissions-route-test-jwt-secret';
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
  const prev = {
    SUPABASE_JWT_SECRET: process.env.SUPABASE_JWT_SECRET,
    SUPABASE_URL: process.env.SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY
  };
  process.env.SUPABASE_JWT_SECRET = SECRET;
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  resetStore();
  const app = buildApp({ logger: false });
  await app.ready();
  app.__restore = () => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
  return app;
}

test('POST /api/kpi-values without session is rejected (401)', async (t) => {
  const app = await makeApp();
  t.after(() => {
    app.close();
    app.__restore();
  });
  const res = await app.inject({
    method: 'POST',
    url: '/api/kpi-values',
    payload: { key: 'bypass_count', period: '2026-07', value: 1 }
  });
  assert.ok([401, 403].includes(res.statusCode));
  assert.notEqual(res.statusCode, 200);
});

test('board_member is denied (403) on KPI value write', async (t) => {
  const app = await makeApp();
  t.after(() => {
    app.close();
    app.__restore();
  });
  const res = await app.inject({
    method: 'POST',
    url: '/api/kpi-values',
    headers: { authorization: `Bearer ${roleToken('board_member')}` },
    payload: { key: 'bypass_count', period: '2026-07', value: 99 }
  });
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().error, 'forbidden');
});

test('admin can POST KPI values (200)', async (t) => {
  const app = await makeApp();
  t.after(() => {
    app.close();
    app.__restore();
  });
  const res = await app.inject({
    method: 'POST',
    url: '/api/kpi-values',
    headers: { authorization: `Bearer ${roleToken('admin')}` },
    payload: {
      key: 'bypass_count',
      period: '2026-07',
      value: 0,
      note: 'admin write'
    }
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().ok, true);
});

test('board_member is denied (403) on KPI definition edit', async (t) => {
  const app = await makeApp();
  t.after(() => {
    app.close();
    app.__restore();
  });
  const res = await app.inject({
    method: 'PUT',
    url: '/api/kpi-definitions/bypass_count',
    headers: { authorization: `Bearer ${roleToken('board_member')}` },
    payload: { definition: 'should not stick' }
  });
  assert.equal(res.statusCode, 403);
});

test('employee can input KPI data but not edit definitions', async (t) => {
  const app = await makeApp();
  t.after(() => {
    app.close();
    app.__restore();
  });
  const post = await app.inject({
    method: 'POST',
    url: '/api/kpi-values',
    headers: { authorization: `Bearer ${roleToken('employee')}` },
    payload: { key: 'bypass_count', period: '2026-08', value: 2 }
  });
  assert.equal(post.statusCode, 200);

  const put = await app.inject({
    method: 'PUT',
    url: '/api/kpi-definitions/bypass_count',
    headers: { authorization: `Bearer ${roleToken('employee')}` },
    payload: { definition: 'employee cannot edit' }
  });
  assert.equal(put.statusCode, 403);
});

test('GET /api/session and GET /me expose role + capabilities', async (t) => {
  const app = await makeApp();
  t.after(() => {
    app.close();
    app.__restore();
  });

  for (const url of ['/me', '/api/session']) {
    const adminRes = await app.inject({
      method: 'GET',
      url,
      headers: { authorization: `Bearer ${roleToken('admin')}` }
    });
    assert.equal(adminRes.statusCode, 200);
    const admin = adminRes.json();
    assert.equal(admin.role, 'admin');
    assert.ok(Array.isArray(admin.capabilities));
    for (const cap of CAPABILITIES) {
      assert.ok(
        admin.capabilities.includes(cap),
        `admin missing ${cap} on ${url}`
      );
    }

    const boardRes = await app.inject({
      method: 'GET',
      url,
      headers: { authorization: `Bearer ${roleToken('board_member')}` }
    });
    assert.equal(boardRes.statusCode, 200);
    const board = boardRes.json();
    assert.equal(board.role, 'board_member');
    for (const cap of CAPABILITIES) {
      assert.ok(
        !board.capabilities.includes(cap),
        `board_member must not have ${cap} on ${url}`
      );
    }
  }
});

test('GET /api/admin requires access_admin_area', async (t) => {
  const app = await makeApp();
  t.after(() => {
    app.close();
    app.__restore();
  });

  const unauth = await app.inject({ method: 'GET', url: '/api/admin' });
  assert.equal(unauth.statusCode, 401);

  const board = await app.inject({
    method: 'GET',
    url: '/api/admin',
    headers: { authorization: `Bearer ${roleToken('board_member')}` }
  });
  assert.equal(board.statusCode, 403);

  const admin = await app.inject({
    method: 'GET',
    url: '/api/admin',
    headers: { authorization: `Bearer ${roleToken('admin')}` }
  });
  assert.equal(admin.statusCode, 200);
  assert.equal(admin.json().ok, true);
});
