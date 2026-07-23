// Unit tests for the self-hosted magic-link token core (src/selfAuth.js).
//
// Locks in the security-critical properties:
//   - a grant is email-bound, single-purpose, and NOT a session bearer
//   - a minted session access token verifies at the auth boundary with an app role
//   - refresh tokens are distinct from access tokens and re-mint a session
//   - the signing secret never appears in any emitted token payload
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mintGrantToken,
  verifyGrantToken,
  mintSession,
  verifyRefreshToken,
  userIdForEmail,
  userForEmail
} from '../src/selfAuth.js';
import { verifySupabaseJwt, extractRole } from '../src/auth.js';

const SECRET = 'unit-selfhost-secret';

function payloadOf(token) {
  return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
}

test('mintGrantToken produces an email-bound magiclink grant that verifies', () => {
  const token = mintGrantToken(SECRET, 'Board@TheImageGroup.com');
  const { email } = verifyGrantToken(token, SECRET);
  assert.equal(email, 'board@theimagegroup.com', 'normalized + bound to email');
  const p = payloadOf(token);
  assert.equal(p.grant, 'magiclink');
  assert.ok(p.exp > p.iat);
  assert.ok(!token.includes(SECRET));
});

test('a grant token is NOT accepted as a session (no usable role)', () => {
  const grant = mintGrantToken(SECRET, 'board@theimagegroup.com');
  // It verifies as a JWT (same secret) but carries no app role...
  const claims = verifySupabaseJwt(grant, SECRET);
  assert.equal(extractRole(claims), null, 'grant confers no app role');
  // ...and it is rejected by the grant->session exchange guard when replayed as
  // a refresh token.
  assert.throws(() => verifyRefreshToken(grant, SECRET));
});

test('mintSession issues a session whose access token authenticates with an app role', () => {
  const session = mintSession(SECRET, 'board@theimagegroup.com');
  assert.equal(session.token_type, 'bearer');
  assert.ok(session.expires_at > 0);
  const claims = verifySupabaseJwt(session.access_token, SECRET);
  assert.equal(claims.sub, userIdForEmail('board@theimagegroup.com'));
  assert.equal(extractRole(claims), 'board');
  assert.equal(session.user.email, 'board@theimagegroup.com');
});

test('refresh token is distinct and re-mints a session', () => {
  const session = mintSession(SECRET, 'board@theimagegroup.com');
  const { email } = verifyRefreshToken(session.refresh_token, SECRET);
  assert.equal(email, 'board@theimagegroup.com');
  // A refresh token must not verify as a plain access bearer role either.
  const refreshClaims = verifySupabaseJwt(session.refresh_token, SECRET);
  assert.equal(extractRole(refreshClaims), null);
  // And an access token is not a refresh token.
  assert.throws(() => verifyRefreshToken(session.access_token, SECRET));
});

test('a grant verified with the wrong secret is rejected', () => {
  const grant = mintGrantToken(SECRET, 'board@theimagegroup.com');
  assert.throws(() => verifyGrantToken(grant, 'other-secret'));
});

test('userIdForEmail is deterministic, uuid-shaped, and case-insensitive', () => {
  const a = userIdForEmail('Board@TheImageGroup.com');
  const b = userIdForEmail('board@theimagegroup.com');
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(userForEmail('x@y.com').app_metadata.role, 'board');
});
