#!/usr/bin/env node
// Mint a short-lived Supabase access_token (JWT) for one invite-only test user,
// entirely server-side, so the live `/me` role check can be automated without a
// browser or a real inbox. This is the documented, scriptable companion to
// scripts/create-test-users.mjs and is referenced by TESTING.md.
//
// How it works (all with the service-role key, no password required — the test
// users are invite-only / passwordless):
//   1. POST /auth/v1/admin/generate_link {type:magiclink,email}  -> hashed_token + email_otp
//   2. POST /auth/v1/verify (magiclink/email)                    -> session { access_token }
// The service-role key is read from the environment ONLY (via supabaseAdmin.js)
// and is never printed. The minted token is a SECRET: it is written to stdout
// ONLY, for immediate capture in the operator's shell, and is never stored or
// logged by this script. Do not commit or paste it anywhere.
//
// Usage (capture straight into the var live-check.sh reads):
//   export SUPABASE_URL=https://<ref>.supabase.co
//   export SUPABASE_SERVICE_ROLE_KEY=<service-role-key-from-vault>
//   FOUNDER_JWT="$(node scripts/mint-test-jwt.mjs --founder)"
//   BOARD_JWT="$(node scripts/mint-test-jwt.mjs --board)"
//   FOUNDER_JWT="$FOUNDER_JWT" BOARD_JWT="$BOARD_JWT" scripts/live-check.sh
//   # or an explicit address you control:
//   node scripts/mint-test-jwt.mjs founder+e2e@yourdomain.com
import { pathToFileURL } from 'node:url';
import { adminConfig, adminFetch } from '../apps/api/src/supabaseAdmin.js';

// Pick the session access_token out of a GoTrue verify response, tolerating the
// shapes GoTrue has used (top-level vs. nested under `session`). Pure — tested.
export function pickAccessToken(body) {
  if (!body || typeof body !== 'object') return null;
  if (typeof body.access_token === 'string' && body.access_token) return body.access_token;
  const session = body.session;
  if (session && typeof session === 'object'
      && typeof session.access_token === 'string' && session.access_token) {
    return session.access_token;
  }
  return null;
}

// Resolve which email to mint for from CLI args + env. Mirrors the non-secret
// defaults documented in TESTING.md and used by create-test-users.mjs. Pure —
// tested. A positional address wins; otherwise --founder/--board pick the
// documented placeholder (override via FOUNDER_TEST_EMAIL / BOARD_TEST_EMAIL).
export function resolveEmail(args, env = process.env) {
  const positional = args.find((a) => a && !a.startsWith('-'));
  if (positional) return positional.trim();
  if (args.includes('--founder')) return (env.FOUNDER_TEST_EMAIL || 'founder.e2e@boardroom.test').trim();
  if (args.includes('--board')) return (env.BOARD_TEST_EMAIL || 'board.e2e@boardroom.test').trim();
  return null;
}

async function readJson(res) {
  const text = await res.text();
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return text;
  }
}

// Generate a magic-link for the user (admin, service-role only) and return the
// non-secret handles needed to complete verification server-side.
async function generateMagicLink(email) {
  const res = await adminFetch('/auth/v1/admin/generate_link', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'magiclink', email }),
  });
  const body = await readJson(res);
  if (!res.ok) {
    throw new Error(`generate_link failed: ${res.status} ${JSON.stringify(body)}`);
  }
  const hashedToken = body?.hashed_token || body?.properties?.hashed_token || null;
  const emailOtp = body?.email_otp || body?.properties?.email_otp || null;
  if (!hashedToken && !emailOtp) {
    throw new Error('generate_link returned neither hashed_token nor email_otp');
  }
  return { hashedToken, emailOtp };
}

// Exchange the magic-link handles for a real session. Tries the token_hash form
// first, then the OTP form, so it works across GoTrue variants.
async function verifyToSession({ email, hashedToken, emailOtp }) {
  const attempts = [];
  if (hashedToken) {
    attempts.push({ type: 'magiclink', token_hash: hashedToken });
    attempts.push({ type: 'magiclink', token: hashedToken, email });
  }
  if (emailOtp) attempts.push({ type: 'email', token: emailOtp, email });

  let lastErr = 'no verify attempt succeeded';
  for (const payload of attempts) {
    const res = await adminFetch('/auth/v1/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const body = await readJson(res);
    const token = res.ok ? pickAccessToken(body) : null;
    if (token) return token;
    lastErr = `verify failed: ${res.status} ${JSON.stringify(body)}`;
  }
  throw new Error(lastErr);
}

async function main() {
  adminConfig(); // fail closed early if SUPABASE_URL / SERVICE_ROLE_KEY are unset
  const email = resolveEmail(process.argv.slice(2));
  if (!email) {
    console.error('usage: node scripts/mint-test-jwt.mjs (--founder | --board | <email>)');
    process.exit(2);
  }
  const { hashedToken, emailOtp } = await generateMagicLink(email);
  const accessToken = await verifyToSession({ email, hashedToken, emailOtp });
  // The ONLY thing on stdout is the token, so it can be captured directly:
  //   FOUNDER_JWT="$(node scripts/mint-test-jwt.mjs --founder)"
  process.stdout.write(`${accessToken}\n`);
  console.error(`ok  minted access_token for ${email} (ephemeral — do not store)`);
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((err) => {
    console.error(`error: ${err.message}`);
    process.exit(1);
  });
}
