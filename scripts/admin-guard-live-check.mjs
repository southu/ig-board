#!/usr/bin/env node
// Admin authorization-guard live acceptance (no browser).
//
// Proves the exact server-side contract the admin guard must uphold against
// LIVE_URL, using the self-hosted magic-link path (inline action_link) to mint
// real admin and non-admin sessions. Every request is a direct HTTP call — no
// browser, no client-side JS — so a pass proves the block is enforced on the
// SERVER, not merely hidden by the SPA:
//
//   AC1: unauthenticated GET /admin (+ aliases) → redirect to /login, never a
//        200 with admin markup.
//   AC2: unauthenticated GET /api/admin/* → 401/403, no admin data in the body.
//   AC3: an admin session GET /admin → 200 with admin panel content.
//   AC4: an admin session GET /api/admin/users → 200 with admin data.
//   AC5: a non-admin (employee) session GET /admin → 403, no admin markup, and
//        GET /api/admin/users → 403 — proving the gate reads the role, not mere
//        session presence (enforcement is server-side).
//   AC6: regression — the home page still returns 200 over HTTPS.
//   AC7: regression — the non-admin session still authenticates on its normal
//        surface (GET /me → 200); it is only blocked from admin.
//
// Emits a non-secret summary only — never prints tokens.
//
// Usage:
//   node scripts/admin-guard-live-check.mjs
//   LIVE_URL=https://… node scripts/admin-guard-live-check.mjs
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

// *.boardroom.test invited accounts whose OTP returns the inline action_link so
// the magic-link session completes without an inbox (see TESTING.md). One admin
// (access_admin_area) and one non-admin (employee) so both sides of the gate are
// exercised with real sessions.
const ADMIN_EMAIL = process.env.ADMIN_TEST_EMAIL || 'ratchet-admin@boardroom.test';
const NONADMIN_EMAIL =
  process.env.NONADMIN_TEST_EMAIL || 'ratchet-employee@boardroom.test';

// Distinctive admin-panel markers. Present in the served admin page (full web
// export uses admin-role-catalog) or the API-only fallback shell (admin-fallback);
// must NOT appear in a redirect or a 403 forbidden body.
const ADMIN_MARKERS = [
  'data-testid="admin-role-catalog"',
  'data-testid="admin-fallback"'
];
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

const results = [];
function ok(name, detail = '') {
  results.push({ name, pass: true, detail });
  console.log(`PASS  ${name}${detail ? ` — ${detail}` : ''}`);
}
function fail(name, detail = '') {
  results.push({ name, pass: false, detail });
  console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
}

function looksLikeAdminPanel(body) {
  return ADMIN_MARKERS.some((m) => body.includes(m));
}

// Complete the invite-only magic-link flow and return the access token — the
// same session shape the browser captures.
async function loginToken(email) {
  const cfg = await fetch(`${LIVE}/config`, { cache: 'no-store' }).then((r) =>
    r.json()
  );
  const { supabaseUrl, supabaseAnonKey } = cfg;
  if (!supabaseUrl || !supabaseAnonKey) throw new Error('loginConfig empty');

  const otp = await fetch(`${supabaseUrl}/auth/v1/otp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: supabaseAnonKey },
    body: JSON.stringify({
      email,
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
  return session.access_token;
}

async function main() {
  // /version reachable (freshness vs the pushed SHA is the caller's check).
  {
    const ver = await fetch(`${LIVE}/version`);
    if (ver.ok) {
      const body = await ver.json();
      ok('GET /version 200', `sha=${(body.sha || '').slice(0, 12)}`);
    } else {
      fail('GET /version 200', `status=${ver.status}`);
    }
  }

  // AC6: regression — home page 200 over HTTPS.
  {
    const home = await fetch(`${LIVE}/`);
    home.status === 200
      ? ok('AC6: GET / → 200')
      : fail('AC6: GET / → 200', `status=${home.status}`);
  }

  // AC1: unauthenticated admin page (+ aliases) → redirect away, no admin shell.
  for (const path of ['/admin', '/admin/', '/admin.html']) {
    const res = await fetch(`${LIVE}${path}`, { redirect: 'manual' });
    const body = await res.text();
    const redirected = REDIRECTS.has(res.status);
    const forbidden = res.status === 403;
    const leaked = looksLikeAdminPanel(body);
    (redirected || forbidden) && !leaked
      ? ok(`AC1: unauth GET ${path} blocked`, `status=${res.status}`)
      : fail(
          `AC1: unauth GET ${path} blocked`,
          `status=${res.status} leaked=${leaked}`
        );
  }

  // AC2: unauthenticated admin API → 401/403, no admin data leaked.
  for (const path of ['/api/admin', '/api/admin/users']) {
    const res = await fetch(`${LIVE}${path}`);
    const body = await res.text();
    const blocked = res.status === 401 || res.status === 403;
    const leaked = /"users"\s*:/.test(body);
    blocked && !leaked
      ? ok(`AC2: unauth GET ${path} → ${res.status}`)
      : fail(`AC2: unauth GET ${path}`, `status=${res.status} leaked=${leaked}`);
  }

  // Non-admin (employee) session.
  let empToken;
  try {
    empToken = await loginToken(NONADMIN_EMAIL);
    ok('non-admin magic-link session minted (AC5/AC7 setup)');
  } catch (e) {
    fail('non-admin magic-link session minted (AC5/AC7 setup)', e.message);
  }
  if (empToken) {
    const auth = { Authorization: `Bearer ${empToken}` };

    // AC7: regression — the non-admin still authenticates on its normal surface.
    const me = await fetch(`${LIVE}/me`, { headers: auth });
    me.status === 200
      ? ok('AC7: non-admin GET /me → 200 (normal access preserved)')
      : fail('AC7: non-admin GET /me → 200', `status=${me.status}`);

    // AC5: non-admin blocked from the admin page — 403, no admin markup.
    const page = await fetch(`${LIVE}/admin`, {
      headers: auth,
      redirect: 'manual'
    });
    const pageBody = await page.text();
    const pageLeaked = looksLikeAdminPanel(pageBody);
    (page.status === 403 || REDIRECTS.has(page.status)) && !pageLeaked
      ? ok('AC5: non-admin GET /admin blocked', `status=${page.status}`)
      : fail(
          'AC5: non-admin GET /admin blocked',
          `status=${page.status} leaked=${pageLeaked}`
        );

    // AC5: non-admin blocked from the admin API — 403, no admin data.
    const api = await fetch(`${LIVE}/api/admin/users`, { headers: auth });
    const apiBody = await api.text();
    const apiLeaked = /"users"\s*:/.test(apiBody);
    api.status === 403 && !apiLeaked
      ? ok('AC5: non-admin GET /api/admin/users → 403')
      : fail(
          'AC5: non-admin GET /api/admin/users → 403',
          `status=${api.status} leaked=${apiLeaked}`
        );
  }

  // Admin session.
  let adminToken;
  try {
    adminToken = await loginToken(ADMIN_EMAIL);
    ok('admin magic-link session minted (AC3/AC4 setup)');
  } catch (e) {
    fail('admin magic-link session minted (AC3/AC4 setup)', e.message);
  }
  if (adminToken) {
    const auth = { Authorization: `Bearer ${adminToken}` };

    // AC3: admin gets the admin page with admin content.
    const page = await fetch(`${LIVE}/admin`, {
      headers: auth,
      redirect: 'manual'
    });
    const pageBody = await page.text();
    page.status === 200 && looksLikeAdminPanel(pageBody)
      ? ok('AC3: admin GET /admin → 200 with admin content')
      : fail(
          'AC3: admin GET /admin → 200 with admin content',
          `status=${page.status} hasContent=${looksLikeAdminPanel(pageBody)}`
        );

    // AC4: admin gets admin data from the admin API.
    const api = await fetch(`${LIVE}/api/admin/users`, { headers: auth });
    const apiBody = await api.text();
    const hasData = /"users"\s*:/.test(apiBody);
    api.status === 200 && hasData
      ? ok('AC4: admin GET /api/admin/users → 200 with data')
      : fail(
          'AC4: admin GET /api/admin/users → 200 with data',
          `status=${api.status} hasData=${hasData}`
        );
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
      join(outDir, 'admin-guard-live-check.json'),
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
  console.error('admin-guard-live-check crashed:', err && err.message);
  process.exit(2);
});
