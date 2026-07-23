// Auth boundary for the Boardroom API.
//
// Every route is protected except the public allowlist (GET /health, /version,
// /ready).
// Requests must carry a Supabase-issued JWT as `Authorization: Bearer <token>`.
// Tokens are verified with HS256 against the project's JWT secret, which is read
// from process.env at runtime only — no secret is ever committed to the repo.
//
// Verification is intentionally dependency-free (Node's built-in crypto) so the
// Railway build has no lockfile/native-module surface to break.
import crypto from 'node:crypto';

// The API's own endpoints reachable without a valid JWT. GET-only. /ready reports
// non-secret boolean config readiness (no values) for live checks / operators.
export const PUBLIC_ROUTES = new Set(['/health', '/version', '/ready']);

// The API data routes that DO require a valid JWT. The same Railway host also
// serves the static web app (/, /login, /_next/*, ...), which is public — the
// client-side guard handles redirecting unauthenticated visitors. So rather than
// deny everything by default (which would 401 the web app), we protect only the
// known authenticated API surface: /me today and any future /api/* route.
export const PROTECTED_ROUTES = new Set(['/me']);

const APP_ROLES = new Set(['founder', 'board']);

function b64urlToBuffer(segment) {
  return Buffer.from(segment, 'base64url');
}

// Resolve the Supabase JWT signing secret from the server environment. This is
// the project's "JWT Secret" (an HMAC key), NOT the service-role key. Returns ''
// when unconfigured, in which case verification fails closed (401 for all).
export function jwtSecret() {
  return (process.env.SUPABASE_JWT_SECRET || process.env.JWT_SECRET || '').trim();
}

// Verify a Supabase HS256 JWT. Throws on any malformed/invalid/expired token.
// On success returns the decoded claims object.
export function verifySupabaseJwt(token, secret = jwtSecret()) {
  if (!secret) {
    const err = new Error('auth not configured');
    err.code = 'AUTH_NOT_CONFIGURED';
    throw err;
  }
  if (typeof token !== 'string' || token.length === 0) {
    throw new Error('missing token');
  }
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('malformed token');
  const [encHeader, encPayload, encSignature] = parts;

  let header;
  try {
    header = JSON.parse(b64urlToBuffer(encHeader).toString('utf8'));
  } catch {
    throw new Error('invalid header');
  }
  // Only HMAC-SHA256 is accepted; reject "alg":"none" and asymmetric algs.
  if (header.alg !== 'HS256') throw new Error('unsupported alg');

  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${encHeader}.${encPayload}`)
    .digest();
  const actual = b64urlToBuffer(encSignature);
  if (
    expected.length !== actual.length ||
    !crypto.timingSafeEqual(expected, actual)
  ) {
    throw new Error('bad signature');
  }

  let payload;
  try {
    payload = JSON.parse(b64urlToBuffer(encPayload).toString('utf8'));
  } catch {
    throw new Error('invalid payload');
  }

  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp === 'number' && now >= payload.exp) {
    throw new Error('token expired');
  }
  if (typeof payload.nbf === 'number' && now < payload.nbf) {
    throw new Error('token not yet valid');
  }
  return payload;
}

// Extract the app role (founder|board) from Supabase JWT claims. Supabase places
// custom claims under app_metadata / user_metadata; different setups may also use
// a top-level or namespaced claim, so we check the common locations liberally.
// The top-level `role` claim is checked last because Supabase sets it to the
// Postgres role ("authenticated"), not the app role.
export function extractRole(claims) {
  if (!claims || typeof claims !== 'object') return null;
  const app = (claims.app_metadata && typeof claims.app_metadata === 'object')
    ? claims.app_metadata
    : {};
  const user = (claims.user_metadata && typeof claims.user_metadata === 'object')
    ? claims.user_metadata
    : {};

  const scalarCandidates = [
    claims.user_role,
    claims.app_role,
    app.role,
    user.role,
    app.user_role,
    user.user_role,
    claims['x-role'],
    claims.role,
  ];
  for (const candidate of scalarCandidates) {
    if (APP_ROLES.has(candidate)) return candidate;
  }

  const listCandidates = [claims.roles, app.roles, user.roles];
  for (const list of listCandidates) {
    if (Array.isArray(list)) {
      if (list.includes('founder')) return 'founder';
      if (list.includes('board')) return 'board';
    }
  }
  return null;
}

// Pull the raw bearer token out of the Authorization header, or null.
export function bearerToken(req) {
  const header = req.headers && req.headers.authorization;
  if (!header || typeof header !== 'string') return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
}

function pathname(req) {
  const url = req.url || '';
  const q = url.indexOf('?');
  return q === -1 ? url : url.slice(0, q);
}

// True when the request may bypass auth (GET on the public API allowlist).
export function isPublicRequest(req) {
  return req.method === 'GET' && PUBLIC_ROUTES.has(pathname(req));
}

// True when the request targets the authenticated API surface (must carry a
// valid JWT): the explicit /me route or any path under /api/. Everything else
// (the static web app + its assets) is public.
export function isProtectedRequest(req) {
  const path = pathname(req);
  return PROTECTED_ROUTES.has(path) || path === '/api' || path.startsWith('/api/');
}

// Fastify onRequest hook enforcing the auth boundary. Registered globally: only
// the protected API surface requires a valid JWT (or gets a 401); the public API
// probes and the static web app pass through.
export function authHook(req, reply, done) {
  if (!isProtectedRequest(req)) {
    done();
    return;
  }
  const token = bearerToken(req);
  if (!token) {
    reply.code(401).send({ error: 'unauthorized', message: 'missing bearer token' });
    return;
  }
  try {
    const claims = verifySupabaseJwt(token);
    req.auth = {
      userId: claims.sub || null,
      role: extractRole(claims),
      email: claims.email || null,
    };
    done();
  } catch {
    // Fail closed on every verification error (bad signature, expired, missing
    // secret, unsupported alg, ...). Never leak the reason.
    reply.code(401).send({ error: 'unauthorized', message: 'invalid or expired token' });
  }
}
