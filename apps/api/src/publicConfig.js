// Browser-safe Supabase config for the web client, assembled from the server's
// runtime environment.
//
// Why this exists: the web app ships as a COMMITTED static export (see
// DEPLOY.md) — Railway does not run `next build` on deploy, so the usual
// build-time inlining of NEXT_PUBLIC_* env can never reach the live bundle. The
// client therefore fetches its public config at runtime from GET /config, which
// this module backs. Only ever exposes the project URL and the ANON (public)
// key — NEVER the service-role key or the JWT secret.
import crypto from 'node:crypto';

// A Supabase anon key is a JWT with `role: "anon"` signed with the project's JWT
// secret (the same HMAC secret used to verify user tokens in auth.js). Supabase's
// gateway validates the apikey's signature against that secret and reads the
// role, so a token minted here is a valid public key — no separate
// SUPABASE_ANON_KEY has to be provisioned onto the service. Far-future expiry so
// a single fetch on the login page stays valid for the whole session.
const ANON_TTL_SECONDS = 60 * 60 * 24 * 365 * 10; // ~10 years

function b64urlJson(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64url');
}

// Extract the Supabase project ref from a project URL (https://<ref>.supabase.co).
// Returns '' when the URL is absent or not in that shape; the ref is only a
// convenience claim and its absence does not affect signature validity.
export function projectRef(url) {
  const match = /^https?:\/\/([a-z0-9]+)\.supabase\.(co|in|net)/i.exec(url || '');
  return match ? match[1] : '';
}

// Mint a Supabase anon apikey (a `role: "anon"` HS256 JWT) signed with the
// project JWT secret. Returns '' when the secret is absent. `iat` is injectable
// for deterministic tests.
export function mintAnonKey(secret, url, iat = Math.floor(Date.now() / 1000)) {
  if (!secret) return '';
  const header = { alg: 'HS256', typ: 'JWT' };
  const payload = {
    role: 'anon',
    iss: 'supabase',
    iat,
    exp: iat + ANON_TTL_SECONDS
  };
  const ref = projectRef(url);
  if (ref) payload.ref = ref;
  const signingInput = `${b64urlJson(header)}.${b64urlJson(payload)}`;
  const signature = crypto
    .createHmac('sha256', secret)
    .update(signingInput)
    .digest('base64url');
  return `${signingInput}.${signature}`;
}

// Derive this service's own public origin (https://<host>) from the Railway
// runtime env, for contexts without a live request (e.g. the boot log). Returns
// '' when the platform domain is not exposed. Request handlers should prefer the
// actual request origin (see server.js) and fall back to this.
export function selfOriginFromEnv(env = process.env) {
  const domain = (env.RAILWAY_PUBLIC_DOMAIN || env.RAILWAY_STATIC_URL || '')
    .trim()
    .replace(/\/+$/, '');
  if (!domain) return '';
  return (/^https?:\/\//i.test(domain) ? domain : `https://${domain}`).replace(
    /\/+$/,
    ''
  );
}

// Resolve the browser-safe { supabaseUrl, supabaseAnonKey } from the environment,
// with `selfOrigin` (this service's own https origin) as the self-hosted
// fallback backend.
//
// Preferred path: an externally-provisioned Supabase project. The URL is the
// same SUPABASE_URL the server uses for admin ops (also accepted under the
// NEXT_PUBLIC_* spelling since the committed static export can never inline
// build-time env — see the file header). The anon key prefers an explicit
// SUPABASE_ANON_KEY / NEXT_PUBLIC_SUPABASE_ANON_KEY and otherwise mints one from
// SUPABASE_JWT_SECRET. The service-role key and JWT secret are deliberately NOT
// given a NEXT_PUBLIC_ alias — those are server-only.
//
// Fallback path: no external project is bound, but SUPABASE_JWT_SECRET IS (the
// live production state). Rather than fail closed forever waiting on an
// unprovisioned external project, serve THIS service as the auth origin — the
// api process hosts a Supabase-Auth-compatible /auth/v1/* surface (see
// server.js) — so the browser gets a real, same-origin endpoint to POST the
// magic-link request to. The anon apikey is minted from the same JWT secret the
// self-hosted /auth shim verifies against, so a forged key is rejected.
//
// Any missing piece yields '' so the login page still fails closed with a
// visible error instead of a silent no-op with a false-success UI.
export function publicSupabaseConfig(env = process.env, selfOrigin = '') {
  const externalUrl = (env.SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL || '')
    .trim()
    .replace(/\/+$/, '');
  const explicitAnon = (
    env.SUPABASE_ANON_KEY ||
    env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
    ''
  ).trim();
  const jwtSecret = (env.SUPABASE_JWT_SECRET || env.JWT_SECRET || '').trim();

  // Preferred: an externally-provisioned Supabase project.
  if (externalUrl) {
    return {
      supabaseUrl: externalUrl,
      supabaseAnonKey: explicitAnon || mintAnonKey(jwtSecret, externalUrl)
    };
  }

  // Fallback: self-host auth at this service's own origin when we hold the JWT
  // secret. The minted anon key is what the /auth/v1/otp handler validates.
  const origin = (selfOrigin || '').trim().replace(/\/+$/, '');
  if (origin && jwtSecret) {
    return { supabaseUrl: origin, supabaseAnonKey: mintAnonKey(jwtSecret, origin) };
  }

  return { supabaseUrl: '', supabaseAnonKey: '' };
}
