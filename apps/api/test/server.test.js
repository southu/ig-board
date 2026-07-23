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
  const prevDb = process.env.DATABASE_URL;
  const prevDomain = process.env.RAILWAY_PUBLIC_DOMAIN;
  delete process.env.SUPABASE_JWT_SECRET;
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.DATABASE_URL;
  delete process.env.RAILWAY_PUBLIC_DOMAIN;
  // Also clear JWT_SECRET alias if present on the host.
  const prevJwtAlias = process.env.JWT_SECRET;
  delete process.env.JWT_SECRET;
  const app = await makeApp();
  t.after(() => {
    app.close();
    const restore = (k, v) => (v === undefined ? delete process.env[k] : (process.env[k] = v));
    restore('SUPABASE_JWT_SECRET', prevSecret);
    restore('SUPABASE_URL', prevUrl);
    restore('SUPABASE_SERVICE_ROLE_KEY', prevKey);
    restore('DATABASE_URL', prevDb);
    restore('RAILWAY_PUBLIC_DOMAIN', prevDomain);
    restore('JWT_SECRET', prevJwtAlias);
  });

  // Unconfigured -> not ready. db_reachable is true when no DATABASE_URL is set
  // (in-memory data path). Probe always returns 200.
  let res = await app.inject({ method: 'GET', url: '/ready' });
  assert.equal(res.statusCode, 200);
  let body = res.json();
  assert.equal(body.ready, false);
  assert.deepEqual(body.checks, {
    jwt_secret_set: false,
    supabase_url_set: false,
    supabase_key_set: false,
    db_reachable: true
  });
  // Every check value is a boolean.
  for (const v of Object.values(body.checks)) assert.equal(typeof v, 'boolean');

  // JWT secret alone + request host (self-host origin) -> all env checks true.
  // The service mints login keys from the secret and hosts /auth at its origin.
  process.env.SUPABASE_JWT_SECRET = SECRET;
  res = await app.inject({
    method: 'GET',
    url: '/ready',
    headers: { host: 'board.example.test' }
  });
  assert.equal(res.statusCode, 200);
  body = res.json();
  assert.equal(body.ready, true);
  assert.deepEqual(body.checks, {
    jwt_secret_set: true,
    supabase_url_set: true,
    supabase_key_set: true,
    db_reachable: true
  });
  // Never echo secrets, connection strings, or JWT-shaped material.
  assert.ok(!res.payload.includes(SECRET));
  assert.ok(!res.payload.includes('eyJ'));
  assert.ok(!res.payload.includes('service_role'));
  assert.ok(!res.payload.includes('postgres://'));

  // External Supabase URL + service-role key still keep checks true and never
  // leak values into the body.
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-secret-value';
  res = await app.inject({ method: 'GET', url: '/ready' });
  assert.equal(res.statusCode, 200);
  body = res.json();
  assert.equal(body.ready, true);
  assert.equal(body.checks.jwt_secret_set, true);
  assert.equal(body.checks.supabase_url_set, true);
  assert.equal(body.checks.supabase_key_set, true);
  assert.equal(body.checks.db_reachable, true);
  assert.ok(!res.payload.includes(SECRET));
  assert.ok(!res.payload.includes('service-role-secret-value'));
  assert.ok(!res.payload.includes('example.supabase.co'));

  // Unreachable DATABASE_URL flips db_reachable false without echoing the URL.
  process.env.DATABASE_URL =
    'postgres://board:sekret-db-pass@127.0.0.1:1/boardroom';
  res = await app.inject({ method: 'GET', url: '/ready' });
  assert.equal(res.statusCode, 200);
  body = res.json();
  assert.equal(body.checks.db_reachable, false);
  assert.equal(body.ready, false);
  assert.ok(!res.payload.includes('sekret-db-pass'));
  assert.ok(!res.payload.includes('postgres://'));
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

// /api/kpi-values feeds the scorecard UI. It is under /api/ so the auth boundary
// requires a valid JWT; with no Supabase admin config it fails SOFT to an empty
// map so the client renders its gray no-data state instead of erroring.
test('GET /api/kpi-values requires a valid JWT (401 without one)', async (t) => {
  const app = await makeApp();
  t.after(() => app.close());
  const res = await app.inject({ method: 'GET', url: '/api/kpi-values' });
  assert.equal(res.statusCode, 401);
});

test('GET /api/kpi-values serves the committed demo seed when admin is unconfigured', async (t) => {
  const prevSecret = process.env.SUPABASE_JWT_SECRET;
  const prevUrl = process.env.SUPABASE_URL;
  const prevKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  process.env.SUPABASE_JWT_SECRET = SECRET;
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  const app = await makeApp();
  t.after(() => {
    app.close();
    const restore = (k, v) => (v === undefined ? delete process.env[k] : (process.env[k] = v));
    restore('SUPABASE_JWT_SECRET', prevSecret);
    restore('SUPABASE_URL', prevUrl);
    restore('SUPABASE_SERVICE_ROLE_KEY', prevKey);
  });
  const token = signJwt({ sub: 'user-1', exp: now() + 3600, app_metadata: { role: 'founder' } });
  const res = await app.inject({
    method: 'GET',
    url: '/api/kpi-values',
    headers: { authorization: `Bearer ${token}` }
  });
  assert.equal(res.statusCode, 200);
  const { values } = res.json();
  // Layer 1 carries a real 6-period series so its band computes a non-gray,
  // worst-status color and its cards render sparklines; the seed's worst KPI is
  // cash runway trending into the red tier.
  const runway = values.cash_runway_months;
  assert.ok(Array.isArray(runway) && runway.length === 6, 'cash_runway_months has a 6-period series');
  assert.equal(runway[runway.length - 1].value, 2, 'latest runway is in the red tier');
  assert.ok(runway.every((p) => typeof p.period === 'string'), 'each point has an ISO period');
  // No secret is ever embedded in the observed values.
  assert.ok(!JSON.stringify(values).includes(SECRET));
});
