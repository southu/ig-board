// Tests for scripts/mint-jwt-offline.mjs — the offline (JWT-secret-only) path that
// mints a founder/board access_token for the live /me role check without a
// Supabase project. The key guarantee: a minted token round-trips through the
// API's own verifier (src/auth.js) and yields the expected app role, so the live
// /me check will accept it. No network, no dependencies. Importing the module must
// NOT run its CLI main() (guarded by the import.meta.url check).
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildClaims, signHs256Jwt, resolveTarget } from '../../../scripts/mint-jwt-offline.mjs';
import { verifySupabaseJwt, extractRole } from '../src/auth.js';

const SECRET = 'test-jwt-secret-do-not-use-in-prod';
// Current epoch seconds so the minted token is unexpired when the API verifier
// (which uses the real clock) checks it.
const now = Math.floor(Date.now() / 1000);

// A minted founder/board token must verify under the real API secret AND resolve
// to the matching app role — exactly what the live GET /me assertion checks.
for (const role of ['founder', 'board']) {
  test(`a minted ${role} token verifies and extractRole returns ${role}`, () => {
    const target = resolveTarget([`--${role}`]);
    const claims = buildClaims({ ...target, now });
    const token = signHs256Jwt(claims, SECRET);

    const decoded = verifySupabaseJwt(token, SECRET);
    assert.equal(extractRole(decoded), role);
    assert.equal(decoded.sub, target.sub);
    assert.equal(decoded.role, 'authenticated'); // top-level = Postgres role, not the app role
  });
}

test('the top-level Postgres role never masks the app role', () => {
  // Regression guard: extractRole must read app_metadata.role, not the top-level
  // "authenticated" the minted claims also carry.
  const claims = buildClaims({ role: 'founder', email: 'f@x.test', sub: 'u1', now });
  assert.equal(claims.role, 'authenticated');
  assert.equal(claims.app_metadata.role, 'founder');
  assert.equal(extractRole(claims), 'founder');
});

test('signHs256Jwt fails closed without a secret', () => {
  assert.throws(() => signHs256Jwt({ sub: 'u1' }, ''), /required to sign/);
});

test('a token signed with the wrong secret is rejected by the API verifier', () => {
  const claims = buildClaims({ role: 'board', email: 'b@x.test', sub: 'u2', now });
  const forged = signHs256Jwt(claims, 'wrong-secret');
  assert.throws(() => verifySupabaseJwt(forged, SECRET), /bad signature/);
});

test('buildClaims sets exp = iat + ttl and honours a custom ttl', () => {
  const claims = buildClaims({ role: 'founder', email: 'f@x.test', sub: 'u1', now, ttlSeconds: 60 });
  assert.equal(claims.iat, now);
  assert.equal(claims.exp, now + 60);
});

test('resolveTarget maps role flags, positional email, and env overrides', () => {
  assert.equal(resolveTarget(['--founder']).role, 'founder');
  assert.equal(resolveTarget(['--founder']).email, 'founder.e2e@boardroom.test');
  assert.equal(resolveTarget(['--board']).email, 'board.e2e@boardroom.test');
  // A positional address overrides the default.
  assert.equal(resolveTarget(['--founder', 'ops@example.com']).email, 'ops@example.com');
  // Env override when no positional is given.
  assert.equal(resolveTarget(['--board'], { BOARD_TEST_EMAIL: 'b+e2e@corp.test' }).email, 'b+e2e@corp.test');
  // No role flag -> null.
  assert.equal(resolveTarget([]), null);
  assert.equal(resolveTarget(['--verbose']), null);
});
