// Integration tests for the wired Fastify app (src/server.js).
//
// Unlike auth.test.js (which unit-tests the hook function), these drive the
// real HTTP surface via Fastify's app.inject() — no port binding, no network.
// They lock in the exact behaviour the live tester checks against Railway:
//   - GET /health  -> 200 without Authorization (public)
//   - GET /version -> 200 without Authorization (public), body carries the SHA
//   - GET /me      -> 401 when the token is missing or garbage
//   - GET /me      -> 200 { id, role } with a valid Supabase-shaped HS256 JWT
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { buildApp } from '../src/server.js';

const SECRET = 'integration-test-jwt-secret';
const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
const now = () => Math.floor(Date.now() / 1000);

function signJwt(payload, secret = SECRET) {
  const header = b64({ alg: 'HS256', typ: 'JWT' });
  const body = b64(payload);
  const sig = crypto.createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${sig}`;
}

// Boot a fresh app per test file run; disable logging to keep test output clean.
async function makeApp() {
  const app = buildApp({ logger: false });
  await app.ready();
  return app;
}

test('GET /health is public and returns 200', async (t) => {
  const app = await makeApp();
  t.after(() => app.close());
  const res = await app.inject({ method: 'GET', url: '/health' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().status, 'ok');
});

test('GET /version is public and returns 200 with a sha field', async (t) => {
  const app = await makeApp();
  t.after(() => app.close());
  const res = await app.inject({ method: 'GET', url: '/version' });
  assert.equal(res.statusCode, 200);
  assert.equal(typeof res.json().sha, 'string');
});

test('GET /ready is public and reports boolean readiness with no secret values', async (t) => {
  const prevSecret = process.env.SUPABASE_JWT_SECRET;
  const prevUrl = process.env.SUPABASE_URL;
  const prevKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const prevAnthropic = process.env.ANTHROPIC_API_KEY;
  delete process.env.SUPABASE_JWT_SECRET;
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  const app = await makeApp();
  t.after(() => {
    app.close();
    const restore = (k, v) => (v === undefined ? delete process.env[k] : (process.env[k] = v));
    restore('SUPABASE_JWT_SECRET', prevSecret);
    restore('SUPABASE_URL', prevUrl);
    restore('SUPABASE_SERVICE_ROLE_KEY', prevKey);
    restore('ANTHROPIC_API_KEY', prevAnthropic);
  });

  // Unconfigured -> not ready, all checks false, still 200 (probe never fails closed).
  let res = await app.inject({ method: 'GET', url: '/ready' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), {
    service: 'ig-board-api',
    ready: false,
    checks: { authSecret: false, supabaseAdmin: false, anthropic: false }
  });

  // Core secrets bound (but not the later ANTHROPIC_API_KEY) -> ready true; the
  // informational `anthropic` flag never gates readiness. Booleans only, never values.
  process.env.SUPABASE_JWT_SECRET = SECRET;
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-secret-value';
  res = await app.inject({ method: 'GET', url: '/ready' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), {
    service: 'ig-board-api',
    ready: true,
    checks: { authSecret: true, supabaseAdmin: true, anthropic: false }
  });
  assert.ok(!res.payload.includes(SECRET));
  assert.ok(!res.payload.includes('service-role-secret-value'));
  assert.ok(!res.payload.includes('example.supabase.co'));

  // ANTHROPIC_API_KEY bound too -> its check flips true; value never leaks.
  process.env.ANTHROPIC_API_KEY = 'sk-ant-should-never-appear-in-body';
  res = await app.inject({ method: 'GET', url: '/ready' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), {
    service: 'ig-board-api',
    ready: true,
    checks: { authSecret: true, supabaseAdmin: true, anthropic: true }
  });
  assert.ok(!res.payload.includes('sk-ant-should-never-appear-in-body'));
});

test('GET /me without Authorization returns 401', async (t) => {
  const app = await makeApp();
  t.after(() => app.close());
  const res = await app.inject({ method: 'GET', url: '/me' });
  assert.equal(res.statusCode, 401);
});

test('GET /me with a garbage bearer token returns 401', async (t) => {
  const app = await makeApp();
  t.after(() => app.close());
  const res = await app.inject({
    method: 'GET',
    url: '/me',
    headers: { authorization: 'Bearer garbage' }
  });
  assert.equal(res.statusCode, 401);
});

test('GET /me with a valid JWT returns 200 with id + role', async (t) => {
  const prev = process.env.SUPABASE_JWT_SECRET;
  process.env.SUPABASE_JWT_SECRET = SECRET;
  const app = await makeApp();
  t.after(() => {
    app.close();
    if (prev === undefined) delete process.env.SUPABASE_JWT_SECRET;
    else process.env.SUPABASE_JWT_SECRET = prev;
  });
  const token = signJwt({ sub: 'user-42', exp: now() + 3600, app_metadata: { role: 'board' } });
  const res = await app.inject({
    method: 'GET',
    url: '/me',
    headers: { authorization: `Bearer ${token}` }
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { id: 'user-42', role: 'board' });
});

// Both app roles must resolve through the real /me surface — this is exactly the
// founder/board mapping the live tester proves against Railway (see TESTING.md).
for (const role of ['founder', 'board']) {
  test(`GET /me maps a valid ${role} JWT to role: ${role}`, async (t) => {
    const prev = process.env.SUPABASE_JWT_SECRET;
    process.env.SUPABASE_JWT_SECRET = SECRET;
    const app = await makeApp();
    t.after(() => {
      app.close();
      if (prev === undefined) delete process.env.SUPABASE_JWT_SECRET;
      else process.env.SUPABASE_JWT_SECRET = prev;
    });
    const token = signJwt({ sub: `user-${role}`, exp: now() + 3600, app_metadata: { role } });
    const res = await app.inject({
      method: 'GET',
      url: '/me',
      headers: { authorization: `Bearer ${token}` }
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { id: `user-${role}`, role });
  });
}
