// Tests for the auth boundary (src/auth.js).
//
// These exercise the security-critical logic with Node's built-in test runner
// and crypto only — no network, no new dependencies, no live Supabase. They
// pin the behaviour the tester verifies against the live deployment:
//   - public GET /health & /version bypass auth
//   - missing / malformed / tampered / expired JWTs are rejected (401)
//   - a valid Supabase-shaped JWT yields the app role (founder|board)
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  verifySupabaseJwt,
  extractRole,
  isSessionUser,
  bearerToken,
  isPublicRequest,
  isProtectedRequest,
  authHook,
  PUBLIC_ROUTES,
} from '../src/auth.js';

const SECRET = 'test-jwt-secret-do-not-use-in-prod';
const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');

// Sign an HS256 JWT the way Supabase does, so tests mirror real tokens.
function signJwt(payload, { secret = SECRET, header = { alg: 'HS256', typ: 'JWT' } } = {}) {
  const encHeader = b64(header);
  const encPayload = b64(payload);
  const sig = crypto
    .createHmac('sha256', secret)
    .update(`${encHeader}.${encPayload}`)
    .digest('base64url');
  return `${encHeader}.${encPayload}.${sig}`;
}

const now = () => Math.floor(Date.now() / 1000);

// --- verifySupabaseJwt -------------------------------------------------------

test('verifySupabaseJwt accepts a valid token and returns its claims', () => {
  const token = signJwt({ sub: 'u1', exp: now() + 3600, app_metadata: { role: 'founder' } });
  const claims = verifySupabaseJwt(token, SECRET);
  assert.equal(claims.sub, 'u1');
  assert.equal(claims.app_metadata.role, 'founder');
});

test('verifySupabaseJwt rejects garbage / malformed tokens', () => {
  assert.throws(() => verifySupabaseJwt('garbage', SECRET));
  assert.throws(() => verifySupabaseJwt('a.b', SECRET));
  assert.throws(() => verifySupabaseJwt('', SECRET));
});

test('verifySupabaseJwt rejects a tampered signature', () => {
  const token = signJwt({ sub: 'u1', exp: now() + 3600 });
  const forged = signJwt({ sub: 'u1', exp: now() + 3600 }, { secret: 'wrong-secret' });
  // same header/payload, different signature segment
  const swapped = token.split('.').slice(0, 2).join('.') + '.' + forged.split('.')[2];
  assert.throws(() => verifySupabaseJwt(swapped, SECRET), /bad signature/);
});

test('verifySupabaseJwt rejects the alg=none downgrade', () => {
  const token = signJwt({ sub: 'u1', exp: now() + 3600 }, { header: { alg: 'none', typ: 'JWT' } });
  assert.throws(() => verifySupabaseJwt(token, SECRET), /unsupported alg/);
});

test('verifySupabaseJwt rejects an expired token', () => {
  const token = signJwt({ sub: 'u1', exp: now() - 10 });
  assert.throws(() => verifySupabaseJwt(token, SECRET), /expired/);
});

test('verifySupabaseJwt fails closed when no secret is configured', () => {
  const token = signJwt({ sub: 'u1', exp: now() + 3600 });
  assert.throws(() => verifySupabaseJwt(token, ''), /not configured/);
});

// --- extractRole -------------------------------------------------------------

test('extractRole reads founder|board from app_metadata / user_metadata / roles', () => {
  assert.equal(extractRole({ app_metadata: { role: 'founder' } }), 'founder');
  assert.equal(extractRole({ user_metadata: { role: 'board' } }), 'board');
  assert.equal(extractRole({ roles: ['board'] }), 'board');
  assert.equal(extractRole({ user_role: 'founder' }), 'founder');
});

test('extractRole ignores the Postgres role and unknown roles', () => {
  // Supabase sets top-level role to "authenticated" — not an app role.
  assert.equal(extractRole({ role: 'authenticated' }), null);
  assert.equal(extractRole({ app_metadata: { role: 'admin' } }), null);
  assert.equal(extractRole(null), null);
  assert.equal(extractRole({}), null);
});

// --- isSessionUser (the private-API gate) ------------------------------------

test('isSessionUser accepts only a genuine member session', () => {
  // A real session access token: has a stable user sub, no anon role, no grant.
  assert.equal(
    isSessionUser({ sub: 'u1', role: 'authenticated', app_metadata: { role: 'board' } }),
    true
  );
  // A token that carries only an app role + sub (older shape) is still a session.
  assert.equal(isSessionUser({ sub: 'u2', app_metadata: { role: 'founder' } }), true);
});

test('isSessionUser rejects the public anon key', () => {
  // The exact claim shape publicConfig.mintAnonKey emits — role:"anon", no sub.
  assert.equal(isSessionUser({ role: 'anon', iss: 'supabase' }), false);
});

test('isSessionUser rejects magic-link grant and refresh tokens', () => {
  assert.equal(isSessionUser({ grant: 'magiclink', email: 'a@b.com' }), false);
  assert.equal(isSessionUser({ grant: 'refresh', sub: 'u1', email: 'a@b.com' }), false);
});

test('isSessionUser rejects junk / subless claims', () => {
  assert.equal(isSessionUser(null), false);
  assert.equal(isSessionUser({}), false);
  assert.equal(isSessionUser({ sub: '' }), false);
});

// --- request helpers ---------------------------------------------------------

test('bearerToken parses the Authorization header', () => {
  assert.equal(bearerToken({ headers: { authorization: 'Bearer abc.def.ghi' } }), 'abc.def.ghi');
  assert.equal(bearerToken({ headers: { authorization: 'bearer abc' } }), 'abc');
  assert.equal(bearerToken({ headers: {} }), null);
  assert.equal(bearerToken({ headers: { authorization: 'Basic xyz' } }), null);
});

test('isPublicRequest allows only GET on the public allowlist', () => {
  assert.equal(PUBLIC_ROUTES.has('/health'), true);
  assert.equal(PUBLIC_ROUTES.has('/version'), true);
  assert.equal(isPublicRequest({ method: 'GET', url: '/health' }), true);
  assert.equal(isPublicRequest({ method: 'GET', url: '/version?x=1' }), true);
  assert.equal(isPublicRequest({ method: 'POST', url: '/health' }), false);
  assert.equal(isPublicRequest({ method: 'GET', url: '/me' }), false);
});

test('isProtectedRequest guards only /me and /api/*; the web app is public', () => {
  // Authenticated API surface -> protected.
  assert.equal(isProtectedRequest({ method: 'GET', url: '/me' }), true);
  assert.equal(isProtectedRequest({ method: 'POST', url: '/me' }), true);
  assert.equal(isProtectedRequest({ method: 'GET', url: '/api/kpis' }), true);
  assert.equal(isProtectedRequest({ method: 'GET', url: '/api' }), true);
  // Static web app + assets + public probes -> not protected (served publicly).
  assert.equal(isProtectedRequest({ method: 'GET', url: '/' }), false);
  assert.equal(isProtectedRequest({ method: 'GET', url: '/login' }), false);
  assert.equal(isProtectedRequest({ method: 'GET', url: '/scorecard' }), false);
  assert.equal(isProtectedRequest({ method: 'GET', url: '/_next/static/x.css' }), false);
  assert.equal(isProtectedRequest({ method: 'GET', url: '/health' }), false);
});

test('authHook lets the public web routes through without a token', () => {
  for (const url of ['/', '/login', '/scorecard', '/_next/static/app.js']) {
    const reply = makeReply();
    let called = false;
    authHook({ method: 'GET', url, headers: {} }, reply, () => { called = true; });
    assert.equal(called, true, `${url} should be public`);
    assert.equal(reply.statusCode, null);
  }
});

// --- authHook (the enforced boundary) ----------------------------------------

// Minimal reply double capturing the status/body the hook would send.
function makeReply() {
  return {
    statusCode: null,
    body: null,
    code(c) { this.statusCode = c; return this; },
    send(b) { this.body = b; return this; },
  };
}

test('authHook lets public GET routes through without a token', () => {
  const reply = makeReply();
  let called = false;
  authHook({ method: 'GET', url: '/health', headers: {} }, reply, () => { called = true; });
  assert.equal(called, true);
  assert.equal(reply.statusCode, null);
});

test('authHook returns 401 for a missing bearer token', () => {
  const reply = makeReply();
  let called = false;
  authHook({ method: 'GET', url: '/me', headers: {} }, reply, () => { called = true; });
  assert.equal(called, false);
  assert.equal(reply.statusCode, 401);
});

test('authHook returns 401 for a garbage token', () => {
  const reply = makeReply();
  let called = false;
  authHook(
    { method: 'GET', url: '/me', headers: { authorization: 'Bearer garbage' } },
    reply,
    () => { called = true; },
  );
  assert.equal(called, false);
  assert.equal(reply.statusCode, 401);
});

test('authHook attaches userId+role for a valid token', () => {
  const prev = process.env.SUPABASE_JWT_SECRET;
  process.env.SUPABASE_JWT_SECRET = SECRET;
  try {
    const token = signJwt({ sub: 'user-9', email: 'x@y.com', exp: now() + 3600, app_metadata: { role: 'board' } });
    const req = { method: 'GET', url: '/me', headers: { authorization: `Bearer ${token}` } };
    const reply = makeReply();
    let called = false;
    authHook(req, reply, () => { called = true; });
    assert.equal(called, true);
    assert.equal(reply.statusCode, null);
    assert.deepEqual(req.auth, { userId: 'user-9', role: 'board', email: 'x@y.com' });
  } finally {
    if (prev === undefined) delete process.env.SUPABASE_JWT_SECRET;
    else process.env.SUPABASE_JWT_SECRET = prev;
  }
});

test('authHook rejects the public anon key on a protected route (401)', () => {
  const prev = process.env.SUPABASE_JWT_SECRET;
  process.env.SUPABASE_JWT_SECRET = SECRET;
  try {
    // A validly-signed anon key (role:"anon") — exactly what GET /config hands
    // every browser. It must NOT authorize the private API.
    const anonKey = signJwt({ role: 'anon', iss: 'supabase', exp: now() + 3600 });
    for (const url of ['/me', '/api/kpi-values']) {
      const req = { method: 'GET', url, headers: { authorization: `Bearer ${anonKey}` } };
      const reply = makeReply();
      let called = false;
      authHook(req, reply, () => { called = true; });
      assert.equal(called, false, `${url} must reject the anon key`);
      assert.equal(reply.statusCode, 401);
    }
  } finally {
    if (prev === undefined) delete process.env.SUPABASE_JWT_SECRET;
    else process.env.SUPABASE_JWT_SECRET = prev;
  }
});

test('authHook rejects a magic-link grant token replayed as a bearer (401)', () => {
  const prev = process.env.SUPABASE_JWT_SECRET;
  process.env.SUPABASE_JWT_SECRET = SECRET;
  try {
    const grant = signJwt({ grant: 'magiclink', email: 'x@y.com', exp: now() + 3600 });
    const req = { method: 'GET', url: '/api/kpi-values', headers: { authorization: `Bearer ${grant}` } };
    const reply = makeReply();
    let called = false;
    authHook(req, reply, () => { called = true; });
    assert.equal(called, false);
    assert.equal(reply.statusCode, 401);
  } finally {
    if (prev === undefined) delete process.env.SUPABASE_JWT_SECRET;
    else process.env.SUPABASE_JWT_SECRET = prev;
  }
});
