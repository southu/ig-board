// Tests for scripts/mint-jwt-offline.mjs — the offline (JWT-secret-only) path that
// mints an admin/board_member access_token for the live /me role check without a
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

// Flag aliases map to governance roles used by /me and the permissions map.
const FLAG_TO_ROLE = [
  { flag: '--founder', role: 'admin' },
  { flag: '--admin', role: 'admin' },
  { flag: '--board', role: 'board_member' },
  { flag: '--board-member', role: 'board_member' }
];

for (const { flag, role } of FLAG_TO_ROLE) {
  test(`a minted ${flag} token verifies and extractRole returns ${role}`, () => {
    const target = resolveTarget([flag]);
    assert.equal(target.role, role);
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
  const claims = buildClaims({ role: 'admin', email: 'f@x.test', sub: 'u1', now });
  assert.equal(claims.role, 'authenticated');
  assert.equal(claims.app_metadata.role, 'admin');
  assert.equal(extractRole(claims), 'admin');
});

test('signHs256Jwt fails closed without a secret', () => {
  assert.throws(() => signHs256Jwt({ sub: 'u1' }, ''), /required to sign/);
});

test('a token signed with the wrong secret is rejected by the API verifier', () => {
  const claims = buildClaims({ role: 'board_member', email: 'b@x.test', sub: 'u2', now });
  const forged = signHs256Jwt(claims, 'wrong-secret');
  assert.throws(() => verifySupabaseJwt(forged, SECRET), /bad signature/);
});

test('buildClaims sets exp = iat + ttl and honours a custom ttl', () => {
  const claims = buildClaims({
    role: 'admin',
    email: 'f@x.test',
    sub: 'u1',
    now,
    ttlSeconds: 60
  });
  assert.equal(claims.iat, now);
  assert.equal(claims.exp, now + 60);
});

test('resolveTarget maps role flags, positional email, and env overrides', () => {
  assert.equal(resolveTarget(['--founder']).role, 'admin');
  assert.equal(resolveTarget(['--admin']).role, 'admin');
  assert.equal(resolveTarget(['--founder']).email, 'admin.e2e@boardroom.test');
  assert.equal(resolveTarget(['--board']).role, 'board_member');
  assert.equal(resolveTarget(['--board']).email, 'board_member.e2e@boardroom.test');
  // A positional address overrides the default.
  assert.equal(resolveTarget(['--founder', 'ops@example.com']).email, 'ops@example.com');
  // Env override when no positional is given.
  assert.equal(
    resolveTarget(['--board'], { BOARD_TEST_EMAIL: 'b+e2e@corp.test' }).email,
    'b+e2e@corp.test'
  );
  assert.equal(
    resolveTarget(['--admin'], { ADMIN_TEST_EMAIL: 'a+e2e@corp.test' }).email,
    'a+e2e@corp.test'
  );
  // No role flag -> null.
  assert.equal(resolveTarget([]), null);
  assert.equal(resolveTarget(['--verbose']), null);
});
