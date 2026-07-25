#!/usr/bin/env node
// Logout / server-side session-revocation live acceptance (no browser).
//
// Proves the exact contract the logout fix must uphold against LIVE_URL, using
// the self-hosted magic-link path (inline action_link) to mint a real session:
//
//   1. A freshly-minted session authenticates (GET /me → 200).
//   2. POST /auth/v1/logout with that session returns 204.
//   3. Replaying the SAME access token afterwards returns 401 at /me AND
//      /auth/v1/user — the server-side session was destroyed, not just the
//      browser copy.
//   4. The logged-out refresh token can no longer mint a fresh session
//      (POST /auth/v1/token?grant_type=refresh_token → 401), so logout cannot
//      be undone by a refresh even though only the access token was presented.
//   5. Regression: the home page still returns 200 over HTTPS.
//   6. Regression: a brand-new login after the logout still yields a working
//      session (the revocation is scoped to the one logged-out session).
//   7. /version reports a deployed SHA (freshness is asserted by the caller
//      against the pushed commit).
//
// Emits a non-secret summary only — never prints tokens.
//
// Usage:
//   node scripts/logout-live-check.mjs
//   LIVE_URL=https://… node scripts/logout-live-check.mjs
//
// Exit 0 on full pass; non-zero on any failure.
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const LIVE = (
  process.env.LIVE_URL ||
  process.env.PLAYWRIGHT_BASE_URL ||
  'https://ig-board-production.up.railway.app'
).replace(/\/+$/, '');

// A *.boardroom.test invited account: OTP returns the inline action_link so the
// magic-link session can be completed without an inbox (see TESTING.md).
const EMAIL = process.env.LOGOUT_TEST_EMAIL || 'ratchet-admin@boardroom.test';

const results = [];
function ok(name, detail = '') {
  results.push({ name, pass: true, detail });
  console.log(`PASS  ${name}${detail ? ` — ${detail}` : ''}`);
}
function fail(name, detail = '') {
  results.push({ name, pass: false, detail });
  console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
}

// Complete the invite-only magic-link flow and return the full session envelope
// ({ access_token, refresh_token, ... }) — the same shape the browser captures.
async function loginSession() {
  const cfg = await fetch(`${LIVE}/config`, { cache: 'no-store' }).then((r) =>
    r.json()
  );
  const { supabaseUrl, supabaseAnonKey } = cfg;
  if (!supabaseUrl || !supabaseAnonKey) throw new Error('loginConfig empty');

  const otp = await fetch(`${supabaseUrl}/auth/v1/otp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: supabaseAnonKey },
    body: JSON.stringify({
      email: EMAIL,
      create_user: false,
      options: { email_redirect_to: `${LIVE}/` }
    })
  });
  if (!otp.ok) throw new Error(`otp ${otp.status}`);
  const otpBody = await otp.json();
  if (!otpBody.action_link) throw new Error('no inline action_link');

  const grant = new URL(otpBody.action_link).searchParams.get('token');
  if (!grant) throw new Error('action_link missing grant token');

  const verify = await fetch(`${supabaseUrl}/auth/v1/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: supabaseAnonKey },
    body: JSON.stringify({ token: grant, type: 'magiclink' })
  });
  if (!verify.ok) throw new Error(`verify ${verify.status}`);
  const session = await verify.json();
  if (!session.access_token) throw new Error('verify returned no access_token');
  return { session, supabaseUrl, supabaseAnonKey };
}

async function status(url, opts) {
  const res = await fetch(url, opts);
  return res.status;
}

async function main() {
  // 7. version reachable (freshness vs the pushed SHA is the caller's check).
  {
    const ver = await fetch(`${LIVE}/version`);
    if (ver.ok) {
      const body = await ver.json();
      ok('GET /version 200', `sha=${(body.sha || '').slice(0, 12)}`);
    } else {
      fail('GET /version 200', `status=${ver.status}`);
    }
  }

  // 5. Regression: home page 200 over HTTPS.
  {
    const home = await status(`${LIVE}/`);
    home === 200 ? ok('GET / → 200') : fail('GET / → 200', `status=${home}`);
  }

  let first;
  try {
    first = await loginSession();
    ok('magic-link session minted (AC1 setup)');
  } catch (e) {
    fail('magic-link session minted (AC1 setup)', e.message);
    return finish();
  }

  const { session, supabaseUrl } = first;
  const authHeader = { Authorization: `Bearer ${session.access_token}` };

  // 1. Fresh session authenticates.
  {
    const before = await status(`${LIVE}/me`, { headers: authHeader });
    before === 200
      ? ok('AC1: fresh session GET /me → 200')
      : fail('AC1: fresh session GET /me → 200', `status=${before}`);
  }

  // 2. Logout succeeds (204 / 2xx).
  {
    const logout = await status(`${LIVE}/auth/v1/logout`, {
      method: 'POST',
      headers: { ...authHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: session.refresh_token })
    });
    logout >= 200 && logout < 300
      ? ok('AC2: POST /auth/v1/logout → 2xx', `status=${logout}`)
      : fail('AC2: POST /auth/v1/logout → 2xx', `status=${logout}`);
  }

  // 3. Replaying the SAME access token now 401s on every authenticated surface.
  {
    const me = await status(`${LIVE}/me`, { headers: authHeader });
    me === 401
      ? ok('AC3: replayed token GET /me → 401')
      : fail('AC3: replayed token GET /me → 401', `status=${me}`);

    const user = await status(`${LIVE}/auth/v1/user`, { headers: authHeader });
    user === 401
      ? ok('AC3: replayed token GET /auth/v1/user → 401')
      : fail('AC3: replayed token GET /auth/v1/user → 401', `status=${user}`);
  }

  // 4. The logged-out refresh token can no longer mint a fresh session.
  {
    const refresh = await status(
      `${supabaseUrl}/auth/v1/token?grant_type=refresh_token`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: first.supabaseAnonKey
        },
        body: JSON.stringify({ refresh_token: session.refresh_token })
      }
    );
    refresh === 401
      ? ok('AC3: revoked refresh token cannot mint session → 401')
      : fail('AC3: revoked refresh token cannot mint session → 401', `status=${refresh}`);
  }

  // 6. Regression: a brand-new login after the logout still works.
  {
    try {
      const second = await loginSession();
      const me = await status(`${LIVE}/me`, {
        headers: { Authorization: `Bearer ${second.session.access_token}` }
      });
      const distinct = second.session.access_token !== session.access_token;
      me === 200 && distinct
        ? ok('AC6: fresh login after logout GET /me → 200')
        : fail('AC6: fresh login after logout GET /me → 200', `status=${me} distinct=${distinct}`);
    } catch (e) {
      fail('AC6: fresh login after logout GET /me → 200', e.message);
    }
  }

  return finish();
}

function finish() {
  const failed = results.filter((r) => !r.pass);
  const summary = {
    live: LIVE,
    at: new Date().toISOString(),
    total: results.length,
    passed: results.length - failed.length,
    failed: failed.length,
    results
  };

  const here = dirname(fileURLToPath(import.meta.url));
  const outDir = join(here, '..', 'e2e', 'evidence');
  try {
    mkdirSync(outDir, { recursive: true });
    writeFileSync(
      join(outDir, 'logout-live-check.json'),
      `${JSON.stringify(summary, null, 2)}\n`
    );
  } catch (e) {
    console.error('could not write evidence:', e.message);
  }

  console.log(
    `\n${summary.passed}/${summary.total} passed` +
      (failed.length ? ` (${failed.length} failed)` : ' — all green')
  );
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error('logout-live-check crashed:', err && err.message);
  process.exit(2);
});
