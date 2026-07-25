// Server-side session/token invalidation for the self-hosted auth backend.
//
// Self-hosted sessions (selfAuth.js) are stateless HS256 JWTs: the auth boundary
// (auth.js) accepts any correctly-signed, unexpired member token, so discarding
// the client's copy on "sign out" left the token fully usable for its whole TTL.
// This module is the server-side session record the stateless design otherwise
// lacks: a logout revokes the presented token(s) here, and the auth boundary +
// refresh exchange consult it so a revoked token is rejected before it can reach
// any authenticated surface — logout now actually destroys the session, not just
// the browser's copy of it.
//
// A revoked token is keyed by a SHA-256 digest of the raw JWT (the token itself
// is never stored), retained only until its own `exp` so the set self-prunes and
// can never outgrow the live token population. In-memory, mirroring the rest of
// the self-hosted auth surface (selfAuth.js runtime invites/roles): single
// Railway instance, and a revoked token that outlives a restart still expires on
// schedule. Dependency-free (Node crypto) to match the zero-lockfile auth core.
import crypto from 'node:crypto';

// digest -> absolute expiry (epoch seconds) after which the entry may be pruned.
const revoked = new Map();

// Retention ceiling for a token whose `exp` cannot be parsed: the longest-lived
// token this app mints is the 30-day refresh token (selfAuth.js), so nothing
// legitimate needs to be remembered longer than that.
const MAX_RETENTION_SECONDS = 60 * 60 * 24 * 30;

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function digest(token) {
  return crypto.createHash('sha256').update(String(token)).digest('base64url');
}

// Best-effort read of a JWT's `exp` claim so a revocation is retained exactly as
// long as the token could otherwise be replayed. Never throws — an unparseable
// token falls back to the bounded retention ceiling.
function tokenExpiry(token) {
  const parts = String(token).split('.');
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return typeof payload.exp === 'number' ? payload.exp : null;
  } catch {
    return null;
  }
}

function prune(now) {
  for (const [key, expiry] of revoked) {
    if (expiry <= now) revoked.delete(key);
  }
}

// Invalidate a session/token so any later use is refused server-side. Safe to
// call with a missing/empty token (no-op) so logout is idempotent. Returns true
// when a token was recorded. This is the single invalidation entry point every
// logout/destroy path shares.
export function revokeSessionToken(token) {
  if (typeof token !== 'string' || token.length === 0) return false;
  const now = nowSeconds();
  prune(now);
  const exp = tokenExpiry(token);
  const expiry = exp === null ? now + MAX_RETENTION_SECONDS : exp;
  // Already-expired token: nothing to remember (the auth boundary rejects it on
  // `exp` alone), so recording it would only be noise.
  if (expiry <= now) return false;
  revoked.set(digest(token), expiry);
  return true;
}

// True when `token` has been revoked and has not yet expired. Consulted by the
// auth boundary (auth.js) and the refresh exchange so a logged-out token cannot
// authenticate or mint a fresh session.
export function isSessionTokenRevoked(token) {
  if (typeof token !== 'string' || token.length === 0) return false;
  const key = digest(token);
  const expiry = revoked.get(key);
  if (expiry === undefined) return false;
  if (expiry <= nowSeconds()) {
    revoked.delete(key);
    return false;
  }
  return true;
}

// Test-only: clear all revocations so suites start from a known state.
export function resetRevokedSessions() {
  revoked.clear();
}

// Test/observability: number of currently-retained revocations.
export function revokedSessionCount() {
  return revoked.size;
}
