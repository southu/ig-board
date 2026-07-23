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

// Resolve the browser-safe { supabaseUrl, supabaseAnonKey } from process.env.
// The URL is the same SUPABASE_URL the server uses for admin ops. The anon key
// prefers an explicitly-provisioned SUPABASE_ANON_KEY (browser-safe, public) and
// otherwise mints one from SUPABASE_JWT_SECRET so the client can call Supabase
// Auth even when only the server secrets are bound. Any missing piece yields ''
// so the login page can fail closed with a visible error instead of a silent
// no-op with a false-success UI.
export function publicSupabaseConfig(env = process.env) {
  const supabaseUrl = (env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
  const explicitAnon = (env.SUPABASE_ANON_KEY || '').trim();
  const jwtSecret = (env.SUPABASE_JWT_SECRET || env.JWT_SECRET || '').trim();
  const supabaseAnonKey =
    explicitAnon || (supabaseUrl ? mintAnonKey(jwtSecret, supabaseUrl) : '');
  return { supabaseUrl, supabaseAnonKey };
}
