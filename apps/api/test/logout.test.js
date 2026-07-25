// Server-side logout / session-revocation tests.
//
// Unit-tests the revocation store (sessionRevocation.js) and drives the wired
// HTTP surface (src/server.js) to lock in the exact behaviour the live tester
// checks: after POST /auth/v1/logout, replaying the SAME token against an
// authenticated endpoint returns 401 — the server-side session is destroyed,
// not just the browser's copy. Fastify app.inject() only, no port binding.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/server.js';
import { mintSession, signJwt } from '../src/selfAuth.js';
import {
  revokeSessionToken,
  isSessionTokenRevoked,
  resetRevokedSessions,
  revokedSessionCount
} from '../src/sessionRevocation.js';

const SECRET = 'integration-test-jwt-secret';
const now = () => Math.floor(Date.now() / 1000);
const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');

// A token whose exp claim we control, so retention/pruning is testable without
// signing (revocation keys off the raw string + the parsed exp, not signature).
function tokenWithExp(exp, tag = 'x') {
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: tag, exp })}.sig-${tag}`;
}

async function makeApp() {
  const app = buildApp({ logger: false });
  await app.ready();
  return app;
}

test('revokeSessionToken then isSessionTokenRevoked reports revoked', () => {
  resetRevokedSessions();
  const token = tokenWithExp(now() + 3600, 'a');
  assert.equal(isSessionTokenRevoked(token), false);
  assert.equal(revokeSessionToken(token), true);
  assert.equal(isSessionTokenRevoked(token), true);
  // A different token is unaffected.
  assert.equal(isSessionTokenRevoked(tokenWithExp(now() + 3600, 'b')), false);
});

test('revocation is a no-op for empty / already-expired tokens', () => {
  resetRevokedSessions();
  assert.equal(revokeSessionToken(''), false);
  assert.equal(revokeSessionToken(null), false);
  assert.equal(revokeSessionToken(tokenWithExp(now() - 10, 'old')), false);
  assert.equal(revokedSessionCount(), 0);
});

test('revoking twice is idempotent', () => {
  resetRevokedSessions();
  const token = tokenWithExp(now() + 3600, 'dup');
  revokeSessionToken(token);
  revokeSessionToken(token);
  assert.equal(revokedSessionCount(), 1);
});

test('POST /auth/v1/logout revokes the access token so GET /me then 401', async (t) => {
  const prev = process.env.SUPABASE_JWT_SECRET;
  process.env.SUPABASE_JWT_SECRET = SECRET;
  resetRevokedSessions();
  const app = await makeApp();
  t.after(() => {
    app.close();
    resetRevokedSessions();
    if (prev === undefined) delete process.env.SUPABASE_JWT_SECRET;
    else process.env.SUPABASE_JWT_SECRET = prev;
  });

  const session = mintSession(SECRET, 'founder.e2e@boardroom.test');

  // 1. The freshly-minted token authenticates (AC1).
  const before = await app.inject({
    method: 'GET',
    url: '/me',
    headers: { authorization: `Bearer ${session.access_token}` }
  });
  assert.equal(before.statusCode, 200);

  // 2. Logout succeeds (AC2) — 204, clears the cookie.
  const logout = await app.inject({
    method: 'POST',
    url: '/auth/v1/logout',
    headers: { authorization: `Bearer ${session.access_token}` },
    payload: { refresh_token: session.refresh_token }
  });
  assert.equal(logout.statusCode, 204);
  assert.match(String(logout.headers['set-cookie'] || ''), /Max-Age=0/);

  // 3. Replaying the SAME access token now 401s (AC3).
  const after = await app.inject({
    method: 'GET',
    url: '/me',
    headers: { authorization: `Bearer ${session.access_token}` }
  });
  assert.equal(after.statusCode, 401);

  // The revoked access token is also refused at /auth/v1/user.
  const user = await app.inject({
    method: 'GET',
    url: '/auth/v1/user',
    headers: { authorization: `Bearer ${session.access_token}` }
  });
  assert.equal(user.statusCode, 401);
});

test('logout revokes the refresh token so it cannot mint a new session', async (t) => {
  const prev = process.env.SUPABASE_JWT_SECRET;
  process.env.SUPABASE_JWT_SECRET = SECRET;
  resetRevokedSessions();
  const app = await makeApp();
  t.after(() => {
    app.close();
    resetRevokedSessions();
    if (prev === undefined) delete process.env.SUPABASE_JWT_SECRET;
    else process.env.SUPABASE_JWT_SECRET = prev;
  });

  const session = mintSession(SECRET, 'founder.e2e@boardroom.test');

  // Refresh works before logout.
  const okRefresh = await app.inject({
    method: 'POST',
    url: '/auth/v1/token?grant_type=refresh_token',
    headers: { apikey: session.access_token, 'content-type': 'application/json' },
    payload: { refresh_token: session.refresh_token }
  });
  assert.equal(okRefresh.statusCode, 200);

  await app.inject({
    method: 'POST',
    url: '/auth/v1/logout',
    headers: { authorization: `Bearer ${session.access_token}` },
    payload: { refresh_token: session.refresh_token }
  });

  // After logout the same refresh token is refused.
  const deadRefresh = await app.inject({
    method: 'POST',
    url: '/auth/v1/token?grant_type=refresh_token',
    headers: { apikey: session.access_token, 'content-type': 'application/json' },
    payload: { refresh_token: session.refresh_token }
  });
  assert.equal(deadRefresh.statusCode, 401);
});

test('logout with only the access token still kills the sibling refresh token', async (t) => {
  const prev = process.env.SUPABASE_JWT_SECRET;
  process.env.SUPABASE_JWT_SECRET = SECRET;
  resetRevokedSessions();
  const app = await makeApp();
  t.after(() => {
    app.close();
    resetRevokedSessions();
    if (prev === undefined) delete process.env.SUPABASE_JWT_SECRET;
    else process.env.SUPABASE_JWT_SECRET = prev;
  });

  const session = mintSession(SECRET, 'founder.e2e@boardroom.test');

  // Log out presenting ONLY the access token — no refresh_token in the body, as
  // a bearer-only client (or a plain GET /logout carrying just the cookie) does.
  const logout = await app.inject({
    method: 'POST',
    url: '/auth/v1/logout',
    headers: { authorization: `Bearer ${session.access_token}` }
  });
  assert.equal(logout.statusCode, 204);

  // The refresh token was never presented to logout, yet it shares the session id
  // of the revoked access token, so it can no longer mint a fresh session —
  // logout cannot be undone by refresh.
  const deadRefresh = await app.inject({
    method: 'POST',
    url: '/auth/v1/token?grant_type=refresh_token',
    headers: { apikey: session.access_token, 'content-type': 'application/json' },
    payload: { refresh_token: session.refresh_token }
  });
  assert.equal(deadRefresh.statusCode, 401);
});

test('logout requires a bearer session — a token only in the body is refused (AC4)', async (t) => {
  const prev = process.env.SUPABASE_JWT_SECRET;
  process.env.SUPABASE_JWT_SECRET = SECRET;
  resetRevokedSessions();
  const app = await makeApp();
  t.after(() => {
    app.close();
    resetRevokedSessions();
    if (prev === undefined) delete process.env.SUPABASE_JWT_SECRET;
    else process.env.SUPABASE_JWT_SECRET = prev;
  });

  const session = mintSession(SECRET, 'founder.e2e@boardroom.test');

  // A caller that presents no Bearer credential — only a token in the body —
  // is NOT an authenticated logout: refuse with 401 and revoke nothing.
  const logout = await app.inject({
    method: 'POST',
    url: '/auth/v1/logout',
    headers: { 'content-type': 'application/json' },
    payload: { access_token: session.access_token }
  });
  assert.equal(logout.statusCode, 401);

  // Because the call was refused, the session is untouched and still authenticates.
  const after = await app.inject({
    method: 'GET',
    url: '/me',
    headers: { authorization: `Bearer ${session.access_token}` }
  });
  assert.equal(after.statusCode, 200);
});

test('logout requires a valid bearer token — bare/garbage refused, replay refused (AC4)', async (t) => {
  const prev = process.env.SUPABASE_JWT_SECRET;
  process.env.SUPABASE_JWT_SECRET = SECRET;
  resetRevokedSessions();
  const app = await makeApp();
  t.after(() => {
    app.close();
    resetRevokedSessions();
    if (prev === undefined) delete process.env.SUPABASE_JWT_SECRET;
    else process.env.SUPABASE_JWT_SECRET = prev;
  });

  // No token at all is refused (not a real logged-in user's logout).
  const bare = await app.inject({ method: 'POST', url: '/auth/v1/logout' });
  assert.equal(bare.statusCode, 401);

  // A garbage / non-JWT bearer is refused.
  const garbage = await app.inject({
    method: 'POST',
    url: '/auth/v1/logout',
    headers: { authorization: 'Bearer not-a-real-token' }
  });
  assert.equal(garbage.statusCode, 401);

  // The public anon key (validly signed, but role:anon / no sub) is not a session.
  const anon = signJwt(SECRET, { role: 'anon', iss: 'ig-board-auth', exp: now() + 3600 });
  const anonLogout = await app.inject({
    method: 'POST',
    url: '/auth/v1/logout',
    headers: { authorization: `Bearer ${anon}` }
  });
  assert.equal(anonLogout.statusCode, 401);

  // A genuine session logs out (204); replaying that now-revoked token is refused.
  const session = mintSession(SECRET, 'founder.e2e@boardroom.test');
  const headers = { authorization: `Bearer ${session.access_token}` };
  assert.equal((await app.inject({ method: 'POST', url: '/auth/v1/logout', headers })).statusCode, 204);
  assert.equal((await app.inject({ method: 'POST', url: '/auth/v1/logout', headers })).statusCode, 401);
});

test('regression: a different, non-revoked session still authenticates after a logout', async (t) => {
  const prev = process.env.SUPABASE_JWT_SECRET;
  process.env.SUPABASE_JWT_SECRET = SECRET;
  resetRevokedSessions();
  const app = await makeApp();
  t.after(() => {
    app.close();
    resetRevokedSessions();
    if (prev === undefined) delete process.env.SUPABASE_JWT_SECRET;
    else process.env.SUPABASE_JWT_SECRET = prev;
  });

  const first = mintSession(SECRET, 'founder.e2e@boardroom.test');
  await app.inject({
    method: 'POST',
    url: '/auth/v1/logout',
    headers: { authorization: `Bearer ${first.access_token}` }
  });

  // A brand-new login (fresh token) is unaffected by the earlier logout (AC6).
  const second = mintSession(SECRET, 'founder.e2e@boardroom.test', now() + 1);
  const res = await app.inject({
    method: 'GET',
    url: '/me',
    headers: { authorization: `Bearer ${second.access_token}` }
  });
  assert.equal(res.statusCode, 200);
  assert.notEqual(first.access_token, second.access_token);
});
