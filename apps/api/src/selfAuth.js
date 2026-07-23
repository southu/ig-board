// Self-hosted, Supabase-Auth (GoTrue) compatible magic-link core.
//
// When no external Supabase project is provisioned but SUPABASE_JWT_SECRET is
// bound (the live production state), the API serves itself as the auth origin.
// This module holds the pure token logic behind that surface — no Fastify, no
// I/O — so it is unit-testable in isolation and the server.js handlers stay thin.
//
// The two token kinds, both HS256 JWTs signed with the SAME project JWT secret
// the auth boundary (auth.js) already verifies against:
//
//   1. A *grant* token (`grant: "magiclink"`) — short-lived, email-bound. It is
//      embedded in the emailed magic link ONLY. It is NOT a session: it carries
//      no app role and the auth boundary rejects it for /api/* because it has no
//      usable role claim, and the verify handler additionally checks the grant
//      claim before exchanging it. So possessing a link (delivered out-of-band
//      to the member's inbox) is the sole gate — there is no self-service path
//      to a session.
//
//   2. A *session* — { access_token, refresh_token, ... } minted only by the
//      verify/token exchange after a valid grant. The access_token is a real
//      Supabase-shaped user JWT (sub, email, role authenticated + app role) that
//      the existing auth boundary accepts for /me and /api/*.
//
// The signing secret is NEVER a payload value and never leaves the server.
import crypto from 'node:crypto';
import { verifySupabaseJwt } from './auth.js';

const GRANT_TTL_SECONDS = 60 * 60; // magic link valid for 1 hour
const ACCESS_TTL_SECONDS = 60 * 60; // session access token: 1 hour
const REFRESH_TTL_SECONDS = 60 * 60 * 24 * 30; // refresh token: 30 days

// App role granted to a member who completes a magic-link sign-in. The Boardroom
// is read-mostly for the board; founder-only mutations key off an explicit
// email allowlist (the invite-only founder test addresses + any FOUNDER_TEST_EMAIL
// override). Server-controlled — never taken from client input.
const DEFAULT_ROLE = 'board';

// Resolve the app role for an email. Founder is reserved for the documented
// founder test address (and optional FOUNDER_TEST_EMAIL override); everyone else
// lands as board. Pure and env-readable so tests can override without touching
// the secret path. Matching is case-insensitive.
export function roleForEmail(email, env = process.env) {
  const normalized = String(email || '').trim().toLowerCase();
  if (!normalized) return DEFAULT_ROLE;
  const founders = new Set(
    [
      'founder.e2e@boardroom.test',
      env.FOUNDER_TEST_EMAIL
    ]
      .filter(Boolean)
      .map((e) => String(e).trim().toLowerCase())
  );
  return founders.has(normalized) ? 'founder' : DEFAULT_ROLE;
}

function b64urlJson(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64url');
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

// Sign an arbitrary claims object as an HS256 JWT with the project secret. The
// same signature scheme the auth boundary + anon key already use.
export function signJwt(secret, payload) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const signingInput = `${b64urlJson(header)}.${b64urlJson(payload)}`;
  const signature = crypto
    .createHmac('sha256', secret)
    .update(signingInput)
    .digest('base64url');
  return `${signingInput}.${signature}`;
}

// Deterministic, stable user id for an email (no user table to allocate one).
// A UUID-shaped digest so downstream consumers that expect a UUID `sub` are
// satisfied and the same member always maps to the same id.
export function userIdForEmail(email) {
  const h = crypto
    .createHash('sha256')
    .update(`ig-board:user:${email.trim().toLowerCase()}`)
    .digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${
    ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16) + h.slice(17, 20)
  }-${h.slice(20, 32)}`;
}

// Mint the short-lived, email-bound grant embedded in the magic link. `grant`
// marks it as a magic-link grant (NOT a session); the verify handler requires
// this claim before exchanging it, and the auth boundary never accepts it as a
// bearer (no app role -> /me returns role null, and it is never sent as one).
export function mintGrantToken(secret, email, iat = nowSeconds()) {
  if (!secret) return '';
  return signJwt(secret, {
    grant: 'magiclink',
    email: email.trim().toLowerCase(),
    iss: 'ig-board-auth',
    iat,
    exp: iat + GRANT_TTL_SECONDS
  });
}

// Verify a grant token: valid signature, unexpired, and the magiclink grant
// claim. Returns { email } or throws.
export function verifyGrantToken(token, secret) {
  const claims = verifySupabaseJwt(token, secret);
  if (claims.grant !== 'magiclink' || typeof claims.email !== 'string') {
    throw new Error('not a magic-link grant');
  }
  return { email: claims.email };
}

// Build the Supabase-shaped user object for a member email.
export function userForEmail(email) {
  const normalized = email.trim().toLowerCase();
  const appRole = roleForEmail(normalized);
  return {
    id: userIdForEmail(normalized),
    aud: 'authenticated',
    role: 'authenticated',
    email: normalized,
    app_metadata: { provider: 'email', role: appRole },
    user_metadata: { role: appRole }
  };
}

// Mint the session access token: a real Supabase-shaped user JWT the auth
// boundary accepts. `role: "authenticated"` is the Postgres role Supabase sets;
// the app role (board/founder) lives in app_metadata, which extractRole reads.
export function mintAccessToken(secret, email, iat = nowSeconds()) {
  const user = userForEmail(email);
  return signJwt(secret, {
    sub: user.id,
    email: user.email,
    aud: 'authenticated',
    role: 'authenticated',
    iss: 'ig-board-auth',
    app_metadata: user.app_metadata,
    user_metadata: user.user_metadata,
    iat,
    exp: iat + ACCESS_TTL_SECONDS
  });
}

// Mint an opaque-to-the-client refresh token (itself a signed JWT so it needs no
// server store). `grant: "refresh"` keeps it distinct from an access token so it
// can never be replayed as a bearer at the auth boundary.
export function mintRefreshToken(secret, email, iat = nowSeconds()) {
  const user = userForEmail(email);
  return signJwt(secret, {
    grant: 'refresh',
    sub: user.id,
    email: user.email,
    iss: 'ig-board-auth',
    iat,
    exp: iat + REFRESH_TTL_SECONDS
  });
}

export function verifyRefreshToken(token, secret) {
  const claims = verifySupabaseJwt(token, secret);
  if (claims.grant !== 'refresh' || typeof claims.email !== 'string') {
    throw new Error('not a refresh token');
  }
  return { email: claims.email };
}

// Assemble the full session envelope the Supabase JS client (and this app's
// localStorage capture) expects.
export function mintSession(secret, email, iat = nowSeconds()) {
  const access_token = mintAccessToken(secret, email, iat);
  const refresh_token = mintRefreshToken(secret, email, iat);
  return {
    access_token,
    refresh_token,
    token_type: 'bearer',
    expires_in: ACCESS_TTL_SECONDS,
    expires_at: iat + ACCESS_TTL_SECONDS,
    user: userForEmail(email)
  };
}
