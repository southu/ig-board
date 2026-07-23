#!/usr/bin/env node
// Mint a Supabase-shaped HS256 access_token (JWT) for one test role — founder or
// board — signed directly with the project's JWT secret, with NO Supabase
// project, network call, or npm dependency involved. This is the offline
// companion to scripts/mint-test-jwt.mjs, referenced by TESTING.md.
//
// Why this exists: the live /me role check (Authorization: Bearer <jwt>) only
// needs a token the API can verify, i.e. one signed with SUPABASE_JWT_SECRET —
// exactly the secret /ready reports as `jwt_secret_set: true`. The full Supabase
// admin path (scripts/mint-test-jwt.mjs) additionally needs a reachable project
// with the service-role key. When only the JWT secret is
// provisioned, this offline path still yields founder/board tokens for the live
// role assertion. It uses Node's built-in crypto only, so it runs without
// `npm install`.
//
// The JWT secret is read from the environment ONLY (via src/auth.js jwtSecret())
// and is never printed. The minted token is a SECRET: it is written to stdout
// ONLY, for immediate capture in the operator's shell, and is never stored or
// logged. Do not commit or paste it anywhere.
//
// Usage (capture straight into the var live-check.sh reads):
//   export SUPABASE_JWT_SECRET=<project jwt secret from the vault>
//   FOUNDER_JWT="$(node scripts/mint-jwt-offline.mjs --founder)"
//   BOARD_JWT="$(node scripts/mint-jwt-offline.mjs --board)"
//   FOUNDER_JWT="$FOUNDER_JWT" BOARD_JWT="$BOARD_JWT" scripts/live-check.sh
//   # or an explicit address you control:
//   node scripts/mint-jwt-offline.mjs --founder ops@example.com
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { jwtSecret } from '../apps/api/src/auth.js';

// Non-secret defaults, mirroring create-test-users.mjs / mint-test-jwt.mjs. The
// `sub` values are stable placeholders (overridable) — the live /me check asserts
// the ROLE, which the API reads from app_metadata.role, not the id.
const ROLE_DEFAULTS = {
  founder: { emailVar: 'FOUNDER_TEST_EMAIL', email: 'founder.e2e@boardroom.test', subVar: 'FOUNDER_TEST_SUB', sub: '00000000-0000-4000-8000-000000000001' },
  board: { emailVar: 'BOARD_TEST_EMAIL', email: 'board.e2e@boardroom.test', subVar: 'BOARD_TEST_SUB', sub: '00000000-0000-4000-8000-000000000002' },
};

// Resolve which role (and email/sub) to mint for from CLI args + env. A --founder
// or --board flag selects the role; an optional positional address overrides the
// default email (else FOUNDER_TEST_EMAIL / BOARD_TEST_EMAIL, else the placeholder).
// Pure — tested. Returns { role, email, sub } or null.
export function resolveTarget(args, env = process.env) {
  const role = args.includes('--founder') ? 'founder' : args.includes('--board') ? 'board' : null;
  if (!role) return null;
  const d = ROLE_DEFAULTS[role];
  const positional = args.find((a) => a && !a.startsWith('-'));
  const email = (positional || env[d.emailVar] || d.email).trim();
  const sub = (env[d.subVar] || d.sub).trim();
  return { role, email, sub };
}

// Build the Supabase-shaped JWT claims for a test user. The app role lives in
// `app_metadata.role` — where the API's extractRole reads it (src/auth.js) — while
// the top-level `role` is the Postgres role ("authenticated"), exactly as Supabase
// issues it. `now` is passed in (seconds since epoch) so the result is
// deterministic and testable. Pure.
export function buildClaims({ role, email, sub, ttlSeconds = 3600, now, iss }) {
  const iat = now;
  const claims = {
    sub,
    aud: 'authenticated',
    role: 'authenticated',
    email,
    app_metadata: { provider: 'email', providers: ['email'], role },
    user_metadata: {},
    iat,
    exp: iat + ttlSeconds,
  };
  if (iss) claims.iss = iss;
  return claims;
}

// Sign an HS256 JWT the way Supabase does. `secret` is the project's JWT secret;
// throws (fail closed) when it is empty so an unconfigured mint never emits a
// token the API would reject anyway. Pure — no I/O.
export function signHs256Jwt(payload, secret) {
  if (!secret) {
    const err = new Error('SUPABASE_JWT_SECRET (or JWT_SECRET) is required to sign a token');
    err.code = 'JWT_SECRET_MISSING';
    throw err;
  }
  const enc = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const encHeader = enc({ alg: 'HS256', typ: 'JWT' });
  const encPayload = enc(payload);
  const sig = crypto
    .createHmac('sha256', secret)
    .update(`${encHeader}.${encPayload}`)
    .digest('base64url');
  return `${encHeader}.${encPayload}.${sig}`;
}

function issFromEnv(env = process.env) {
  const url = (env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
  return url ? `${url}/auth/v1` : undefined;
}

function main() {
  const secret = jwtSecret();
  if (!secret) {
    console.error('error: SUPABASE_JWT_SECRET (or JWT_SECRET) is not set — cannot sign a token');
    process.exit(2);
  }
  const target = resolveTarget(process.argv.slice(2));
  if (!target) {
    console.error('usage: node scripts/mint-jwt-offline.mjs (--founder | --board) [email]');
    process.exit(2);
  }
  const now = Math.floor(Date.now() / 1000);
  const ttlSeconds = Number(process.env.JWT_TTL_SECONDS) || 3600;
  const claims = buildClaims({ ...target, ttlSeconds, now, iss: issFromEnv() });
  const token = signHs256Jwt(claims, secret);
  // The ONLY thing on stdout is the token, so it can be captured directly:
  //   FOUNDER_JWT="$(node scripts/mint-jwt-offline.mjs --founder)"
  process.stdout.write(`${token}\n`);
  console.error(`ok  minted offline HS256 JWT for ${target.role} <${target.email}> (ephemeral — do not store)`);
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main();
}
