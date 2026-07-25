#!/usr/bin/env node
// Admin NAV-LINK live acceptance (no browser).
//
// Proves the header "Admin" nav entry point contract against LIVE_URL using the
// self-hosted magic-link path (inline action_link) to mint real admin and
// non-admin sessions. This is the nav-link companion to
// scripts/admin-guard-live-check.mjs (which proves the SERVER-side /admin gate):
// here we prove the entry point that leads a user to that gate is present for
// admins, absent for everyone else, and points at the right route — driven
// solely by the capabilities model, not a separate is_admin flag.
//
//   NAV1: the shipped client bundle renders the Admin link gated by the
//         access_admin_area capability — data-testid="admin-nav", href="/admin",
//         text "Admin" — in the same nav bundle as the Sign out control. (The
//         per-role DOM visibility itself is exercised by the browser tester; the
//         checkable server-side proof is that the gating logic + testid ship in
//         the deployed bundle alongside the existing nav + sign-out testids.)
//   NAV2 (AC4): GET /me for the admin session lists access_admin_area, so
//         AdminNav renders the link; GET /me for the employee session does NOT,
//         so AdminNav renders nothing.
//   NAV3 (AC2): the admin session GET /admin → 200 (the link's target loads).
//   NAV4 (AC5): unauthenticated GET /admin stays blocked (redirect/401/403) —
//         nav visibility never relaxes the server gate.
//   NAV5 (AC6): regression — GET / and GET /login → 200.
//   NAV6 (AC8): regression — GET /version → 200 with a sha field.
//
// Emits a non-secret summary only — never prints tokens.
//
// Usage:
//   node scripts/admin-nav-live-check.mjs
//   LIVE_URL=https://… node scripts/admin-nav-live-check.mjs
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
// (access_admin_area) and one non-admin (employee) so both sides of the nav gate
// are exercised with real sessions.
const ADMIN_EMAIL = process.env.ADMIN_TEST_EMAIL || 'ratchet-admin@boardroom.test';
const NONADMIN_EMAIL =
  process.env.NONADMIN_TEST_EMAIL || 'ratchet-employee@boardroom.test';

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

async function meCapabilities(token) {
  const res = await fetch(`${LIVE}/me`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: 'no-store'
  });
  if (!res.ok) throw new Error(`/me ${res.status}`);
  const body = await res.json();
  return Array.isArray(body.capabilities) ? body.capabilities : [];
}

// Fetch the homepage HTML plus every /_next chunk it references, concatenated.
// The static nav links (Memos/Analysis/…) render server-side into the exported
// HTML, while AdminNav and Sign out are client components whose gating logic +
// testids live in a shared layout chunk — so both surfaces must be searched,
// regardless of the current build hash.
async function shippedBundle() {
  const html = await fetch(`${LIVE}/`, { cache: 'no-store' }).then((r) => r.text());
  const chunks = [...new Set(html.match(/\/_next\/static\/chunks\/[^"']+\.js/g) || [])];
  const bodies = await Promise.all(
    chunks.map((c) => fetch(`${LIVE}${c}`).then((r) => (r.ok ? r.text() : '')))
  );
  return [html, ...bodies].join('\n');
}

async function main() {
  // NAV1: the Admin link + its capability gate ship in the deployed bundle,
  // next to the existing nav links and the sign-out control.
  try {
    const bundle = await shippedBundle();
    const has = (s) => bundle.includes(s);
    const navTestids = [
      'nav-memos',
      'nav-analysis',
      'nav-comments',
      'nav-agenda',
      'nav-whats-new'
    ];
    const missingNav = navTestids.filter((t) => !has(t));
    const adminLinkShipped =
      has('admin-nav') && has('access_admin_area') && has('/admin');
    const signOutShipped = has('sign-out');
    if (adminLinkShipped && signOutShipped && missingNav.length === 0) {
      ok(
        'NAV1: Admin link (admin-nav, /admin) gated by access_admin_area ships beside sign-out + nav links'
      );
    } else {
      fail(
        'NAV1: Admin link gated by access_admin_area ships beside sign-out + nav links',
        `adminLink=${adminLinkShipped} signOut=${signOutShipped} missingNav=[${missingNav.join(',')}]`
      );
    }
  } catch (e) {
    fail('NAV1: shipped bundle inspected', e.message);
  }

  // Admin session.
  let adminToken;
  try {
    adminToken = await loginToken(ADMIN_EMAIL);
    ok('admin magic-link session minted');
  } catch (e) {
    fail('admin magic-link session minted', e.message);
  }
  if (adminToken) {
    // NAV2 (AC4): admin /me carries access_admin_area → AdminNav renders.
    try {
      const caps = await meCapabilities(adminToken);
      caps.includes('access_admin_area')
        ? ok('NAV2/AC4: admin GET /me capabilities include access_admin_area')
        : fail(
            'NAV2/AC4: admin GET /me capabilities include access_admin_area',
            `caps=[${caps.join(',')}]`
          );
    } catch (e) {
      fail('NAV2/AC4: admin GET /me capabilities include access_admin_area', e.message);
    }

    // NAV3 (AC2): the link's target loads for the admin session.
    const page = await fetch(`${LIVE}/admin`, {
      headers: { Authorization: `Bearer ${adminToken}` },
      redirect: 'manual'
    });
    page.status === 200
      ? ok('NAV3/AC2: admin GET /admin → 200 (link target loads)')
      : fail('NAV3/AC2: admin GET /admin → 200 (link target loads)', `status=${page.status}`);
  }

  // Non-admin (employee) session.
  let empToken;
  try {
    empToken = await loginToken(NONADMIN_EMAIL);
    ok('employee magic-link session minted');
  } catch (e) {
    fail('employee magic-link session minted', e.message);
  }
  if (empToken) {
    // NAV2 (AC4): employee /me lacks access_admin_area → AdminNav renders nothing.
    try {
      const caps = await meCapabilities(empToken);
      !caps.includes('access_admin_area')
        ? ok('NAV2/AC4: employee GET /me capabilities exclude access_admin_area')
        : fail(
            'NAV2/AC4: employee GET /me capabilities exclude access_admin_area',
            `caps=[${caps.join(',')}]`
          );
    } catch (e) {
      fail(
        'NAV2/AC4: employee GET /me capabilities exclude access_admin_area',
        e.message
      );
    }
  }

  // NAV4 (AC5): nav visibility never relaxes the server gate.
  {
    const res = await fetch(`${LIVE}/admin`, { redirect: 'manual' });
    const blocked = REDIRECTS.has(res.status) || res.status === 401 || res.status === 403;
    blocked
      ? ok('NAV4/AC5: unauth GET /admin blocked', `status=${res.status}`)
      : fail('NAV4/AC5: unauth GET /admin blocked', `status=${res.status}`);
  }

  // NAV5 (AC6): regression — home + login load.
  for (const path of ['/', '/login']) {
    const res = await fetch(`${LIVE}${path}`);
    res.status === 200
      ? ok(`NAV5/AC6: GET ${path} → 200`)
      : fail(`NAV5/AC6: GET ${path} → 200`, `status=${res.status}`);
  }

  // NAV6 (AC8): regression — version endpoint healthy with a sha.
  {
    const res = await fetch(`${LIVE}/version`);
    if (res.status === 200) {
      const body = await res.json().catch(() => ({}));
      body && typeof body.sha === 'string' && body.sha
        ? ok('NAV6/AC8: GET /version → 200 with sha', `sha=${body.sha.slice(0, 12)}`)
        : fail('NAV6/AC8: GET /version → 200 with sha', 'missing sha');
    } else {
      fail('NAV6/AC8: GET /version → 200 with sha', `status=${res.status}`);
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
      join(outDir, 'admin-nav-live-check.json'),
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
  console.error('admin-nav-live-check crashed:', err && err.message);
  process.exit(2);
});
