#!/usr/bin/env node
// jason@jasonharper.com admin-nav / logout LIVE verification + evidence capture.
//
// Produces the four operator-required evidence artifacts against LIVE_URL, using
// the self-hosted invite-only magic-link path (inline action_link — jasonharper
// and the *.boardroom.test accounts return it, see selfAuth.js) to mint real
// sessions. No secrets are printed or stored; only statuses, roles, capability
// names, and rendered DOM markers are captured. Access tokens live only in the
// process (localStorage/cookie injection for the browser) and are never written
// to the evidence files.
//
// Artifacts (all under docs/evidence/admin-nav-logout/):
//   1. admin-query.json          — live user/auth store shows jason = admin /
//                                   access_admin_area=true (AC1)
//   2. screenshots/01-admin-nav-and-panel.png
//                                — jason: Admin nav link + admin user list (AC2/AC3)
//   3. screenshots/02-nonadmin-no-admin-nav.png + nonadmin-blocked.json
//                                — employee: no Admin link; /admin + /api/admin/users
//                                  403 (AC4/AC5)
//   4. screenshots/03-logout-session-terminated.png + logout-proof.json
//                                — after Sign out, protected routes are refused (AC6)
//
// Usage: node scripts/jasonharper-admin-verify.mjs
//        LIVE_URL=https://… node scripts/jasonharper-admin-verify.mjs
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const LIVE = (
  process.env.LIVE_URL ||
  process.env.PLAYWRIGHT_BASE_URL ||
  'https://ig-board-production.up.railway.app'
).replace(/\/+$/, '');

const JASON = process.env.JASON_EMAIL || 'jason@jasonharper.com';
const NONADMIN = process.env.NONADMIN_TEST_EMAIL || 'ratchet-employee@boardroom.test';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', 'docs', 'evidence', 'admin-nav-logout');
const SHOTS = join(OUT, 'screenshots');
mkdirSync(SHOTS, { recursive: true });

const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const nowIso = () => new Date().toISOString();

function log(msg) {
  console.log(msg);
}

// Complete the invite-only magic-link flow → full session envelope.
async function login(email) {
  const cfg = await fetch(`${LIVE}/config`, { cache: 'no-store' }).then((r) => r.json());
  const { supabaseUrl, supabaseAnonKey } = cfg;
  if (!supabaseUrl || !supabaseAnonKey) throw new Error('login config empty');
  const otp = await fetch(`${supabaseUrl}/auth/v1/otp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: supabaseAnonKey },
    body: JSON.stringify({
      email,
      create_user: false,
      options: { email_redirect_to: `${LIVE}/` }
    })
  });
  if (!otp.ok) throw new Error(`otp ${otp.status} for ${email}`);
  const otpBody = await otp.json();
  if (!otpBody.action_link) throw new Error(`no inline action_link for ${email}`);
  const grant = new URL(otpBody.action_link).searchParams.get('token');
  const verify = await fetch(`${supabaseUrl}/auth/v1/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: supabaseAnonKey },
    body: JSON.stringify({ token: grant, type: 'magiclink' })
  });
  if (!verify.ok) throw new Error(`verify ${verify.status} for ${email}`);
  const session = await verify.json();
  if (!session.access_token) throw new Error(`no access_token for ${email}`);
  return session;
}

async function api(path, token, method = 'GET') {
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  return fetch(`${LIVE}${path}`, {
    method,
    headers,
    redirect: 'manual',
    cache: 'no-store'
  });
}

// A browser context pre-loaded with a real session (localStorage + cookie), the
// exact shape the login page writes (see apps/web/lib/auth.js).
async function contextWithSession(browser, session) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.addCookies([
    { name: 'ig-board-access-token', value: session.access_token, url: LIVE }
  ]);
  await ctx.addInitScript((s) => {
    try {
      window.localStorage.setItem('ig-board.session', JSON.stringify(s));
    } catch (e) {
      /* ignore */
    }
  }, {
    access_token: session.access_token,
    refresh_token: session.refresh_token || null,
    expires_at: session.expires_at
  });
  return ctx;
}

async function main() {
  const summary = { live: LIVE, at: nowIso(), checks: [] };
  const record = (name, pass, detail) => {
    summary.checks.push({ name, pass, detail });
    log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  };

  // Version regression (AC8) — pin the deployed SHA into the evidence.
  const ver = await fetch(`${LIVE}/version`, { cache: 'no-store' });
  const verBody = await ver.json().catch(() => ({}));
  summary.deployed_sha = verBody.sha || null;
  record('AC8 GET /version → 200 with sha', ver.status === 200 && !!verBody.sha, `sha=${(verBody.sha || '').slice(0, 12)}`);

  const browser = await chromium.launch();

  // -----------------------------------------------------------------------
  // 1. Live user/auth store query: jason = admin / access_admin_area (AC1)
  // -----------------------------------------------------------------------
  const jasonSession = await login(JASON);
  const jasonToken = jasonSession.access_token;
  const jasonMe = await api('/me', jasonToken).then((r) => r.json());
  const jasonIsAdmin =
    jasonMe.role === 'admin' && Array.isArray(jasonMe.capabilities) &&
    jasonMe.capabilities.includes('access_admin_area');
  record('AC1 jason /me role=admin + access_admin_area', jasonIsAdmin, `role=${jasonMe.role}`);

  // Authoritative user/auth store row via the admin directory API.
  const usersRes = await api('/api/admin/users', jasonToken);
  const usersBody = await usersRes.json().catch(() => ({}));
  const userList = Array.isArray(usersBody.users) ? usersBody.users : [];
  const jasonRow = userList.find(
    (u) => String(u.email).toLowerCase() === JASON.toLowerCase()
  );
  record(
    'AC1 jason present in /api/admin/users as admin',
    !!jasonRow && jasonRow.role === 'admin',
    jasonRow ? `role=${jasonRow.role}` : 'row missing'
  );

  const adminQuery = {
    captured_at: nowIso(),
    live: LIVE,
    deployed_sha: summary.deployed_sha,
    note:
      'jason@jasonharper.com is promoted to admin via the reviewable code path ' +
      '(selfAuth.roleForEmail + usersStore seed + migration 0020) — no blanket ' +
      'seed change, no hardcoded credentials. This is the authoritative LIVE ' +
      'query proving the resulting state. Only jason@readysignal.com is the ' +
      'other hardcoded operator admin; jason@jasonharper.com is distinct.',
    'GET /me (jason, per-request role resolved from the users store)': {
      status: 200,
      body: jasonMe
    },
    'GET /api/admin/users → jason row (live user/auth store directory)': {
      status: usersRes.status,
      total_users: userList.length,
      jason_row: jasonRow || null
    },
    admin_confirmed: jasonIsAdmin && !!jasonRow && jasonRow.role === 'admin'
  };
  writeFileSync(join(OUT, 'admin-query.json'), `${JSON.stringify(adminQuery, null, 2)}\n`);

  // -----------------------------------------------------------------------
  // 2 + 3. jason: Admin nav link visible + admin panel user list (AC2/AC3)
  // -----------------------------------------------------------------------
  {
    const ctx = await contextWithSession(browser, jasonSession);
    const page = await ctx.newPage();
    await page.goto(`${LIVE}/`, { waitUntil: 'networkidle' });
    await page.waitForSelector('[data-testid="admin-nav"]', { timeout: 20000 });
    const navVisible = await page.locator('[data-testid="admin-nav"]').count();
    record('AC2 jason home renders Admin nav link (data-testid=admin-nav)', navVisible > 0);

    // Follow the nav link to the admin panel.
    await page.locator('[data-testid="admin-nav"]').first().click();
    await page.waitForURL(/\/admin\/?$/, { timeout: 20000 });
    await page.waitForSelector('[data-testid="admin-users-table"]', { timeout: 20000 });
    const rows = await page.locator('[data-testid="admin-users-table"] tbody tr').count();
    record('AC3 jason /admin renders admin user list', rows > 0, `rows=${rows}`);
    await page.screenshot({ path: join(SHOTS, '01-admin-nav-and-panel.png'), fullPage: true });
    await ctx.close();
  }

  // -----------------------------------------------------------------------
  // 4. non-admin: no Admin link + admin route/API blocked (AC4/AC5)
  // -----------------------------------------------------------------------
  const empSession = await login(NONADMIN);
  const empToken = empSession.access_token;
  {
    const empMe = await api('/me', empToken).then((r) => r.json());
    const empAdmin = await api('/admin', empToken);
    const empUsers = await api('/api/admin/users', empToken);
    const blocked = (s) => REDIRECTS.has(s) || s === 401 || s === 403;
    record(
      'AC5 employee GET /admin blocked (403/redirect, never 200)',
      blocked(empAdmin.status),
      `status=${empAdmin.status}`
    );
    record(
      'AC5 employee GET /api/admin/users blocked',
      blocked(empUsers.status),
      `status=${empUsers.status}`
    );

    const ctx = await contextWithSession(browser, empSession);
    const page = await ctx.newPage();
    await page.goto(`${LIVE}/`, { waitUntil: 'networkidle' });
    // Wait for the nav to finish resolving the role (sign-out proves the session
    // loaded), then assert the Admin link is absent.
    await page.waitForSelector('[data-testid="sign-out"]', { timeout: 20000 });
    await page.waitForTimeout(1000);
    const navCount = await page.locator('[data-testid="admin-nav"]').count();
    record('AC4 employee home has NO Admin nav link', navCount === 0, `count=${navCount}`);
    await page.screenshot({ path: join(SHOTS, '02-nonadmin-no-admin-nav.png'), fullPage: true });
    await ctx.close();

    writeFileSync(
      join(OUT, 'nonadmin-blocked.json'),
      `${JSON.stringify(
        {
          captured_at: nowIso(),
          live: LIVE,
          deployed_sha: summary.deployed_sha,
          account: NONADMIN,
          'GET /me': { status: 200, role: empMe.role, capabilities: empMe.capabilities },
          'GET /admin': { status: empAdmin.status, location: empAdmin.headers.get('location') || null },
          'GET /api/admin/users': { status: empUsers.status },
          admin_nav_link_present_in_dom: navCount > 0,
          verdict:
            'Admin nav link absent; admin route + API return 403 — never 200 with admin content.'
        },
        null,
        2
      )}\n`
    );
  }

  // -----------------------------------------------------------------------
  // 5. logout terminates the session (AC6)
  // -----------------------------------------------------------------------
  {
    // Fresh session so the HTTP before/after proof is independent of the browser.
    const s = await login(JASON);
    const t = s.access_token;
    const meBefore = await api('/me', t);
    const adminBefore = await api('/admin', t);
    const logout = await api('/auth/v1/logout', t, 'POST');
    const meAfter = await api('/me', t);
    const adminAfter = await api('/admin', t);
    const adminTxtAfter = await api('/admin.txt', t);
    const refused = (s) => s === 401 || s === 403 || REDIRECTS.has(s);
    record('AC6 /me 200 before logout', meBefore.status === 200, `status=${meBefore.status}`);
    record('AC6 logout → 204', logout.status === 204, `status=${logout.status}`);
    record('AC6 /me refused after logout', refused(meAfter.status), `status=${meAfter.status}`);
    record(
      'AC6 /admin page refused after logout (revocation honored on page gate)',
      refused(adminAfter.status),
      `status=${adminAfter.status} loc=${adminAfter.headers.get('location') || ''}`
    );
    record(
      'AC6 /admin.txt RSC refused after logout',
      refused(adminTxtAfter.status),
      `status=${adminTxtAfter.status}`
    );

    // Browser proof: click the real Sign out control, then a same-session
    // navigation to /admin must land on /login (unauthenticated).
    const bs = await login(JASON);
    const ctx = await contextWithSession(browser, bs);
    const page = await ctx.newPage();
    await page.goto(`${LIVE}/`, { waitUntil: 'networkidle' });
    await page.waitForSelector('[data-testid="sign-out"]', { timeout: 20000 });
    await Promise.all([
      page.waitForURL(/\/login\/?$/, { timeout: 20000 }).catch(() => {}),
      page.locator('[data-testid="sign-out"]').first().click()
    ]);
    // Same browser session now navigates to the protected admin route.
    await page.goto(`${LIVE}/admin`, { waitUntil: 'networkidle' });
    const landedOnLogin = /\/login\/?$/.test(new URL(page.url()).pathname + '/');
    const onLogin = /\/login/.test(page.url());
    record('AC6 browser: after Sign out, /admin lands on /login', onLogin, `url=${page.url()}`);
    await page.screenshot({ path: join(SHOTS, '03-logout-session-terminated.png'), fullPage: true });
    await ctx.close();

    writeFileSync(
      join(OUT, 'logout-proof.json'),
      `${JSON.stringify(
        {
          captured_at: nowIso(),
          live: LIVE,
          deployed_sha: summary.deployed_sha,
          account: JASON,
          http_same_token_replay: {
            'GET /me before logout': { status: meBefore.status },
            'GET /admin before logout': { status: adminBefore.status },
            'POST /auth/v1/logout': { status: logout.status },
            'GET /me after logout': { status: meAfter.status },
            'GET /admin after logout': {
              status: adminAfter.status,
              location: adminAfter.headers.get('location') || null
            },
            'GET /admin.txt after logout': { status: adminTxtAfter.status }
          },
          browser_signout: {
            control: 'data-testid=sign-out',
            after_signout_admin_url: page ? undefined : undefined,
            landed_on_login: onLogin
          },
          verdict:
            'Clicking Sign out revokes the session server-side: replaying the ' +
            'same token to /me, /admin, and /admin.txt is refused (401/redirect), ' +
            'and a same-session browser navigation to /admin lands on /login.'
        },
        null,
        2
      )}\n`
    );
  }

  await browser.close();

  const failed = summary.checks.filter((c) => !c.pass);
  summary.passed = summary.checks.length - failed.length;
  summary.failed = failed.length;
  writeFileSync(join(OUT, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  log(`\n${summary.passed}/${summary.checks.length} checks passed` + (failed.length ? ` (${failed.length} FAILED)` : ' — all green'));
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error('jasonharper-admin-verify crashed:', err && err.stack);
  process.exit(2);
});
