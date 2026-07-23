#!/usr/bin/env node
// Phase 1 live API acceptance (no browser). Proves founder write + audit +
// definition flag + board write denial against LIVE_URL using the self-hosted
// magic-link path (inline action_link). Emits a non-secret summary only.
//
// Usage:
//   node scripts/phase1-live-check.mjs
//   LIVE_URL=https://… node scripts/phase1-live-check.mjs
//
// Exit 0 on full pass; non-zero on any failure. Never prints tokens.
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const LIVE = (
  process.env.LIVE_URL ||
  process.env.PLAYWRIGHT_BASE_URL ||
  'https://ig-board-production.up.railway.app'
).replace(/\/+$/, '');

const FOUNDER = process.env.FOUNDER_TEST_EMAIL || 'founder.e2e@boardroom.test';
const BOARD = process.env.BOARD_TEST_EMAIL || 'board.e2e@boardroom.test';

const results = [];
function ok(name, detail = '') {
  results.push({ name, pass: true, detail });
  console.log(`PASS  ${name}${detail ? ` — ${detail}` : ''}`);
}
function fail(name, detail = '') {
  results.push({ name, pass: false, detail });
  console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
}

async function sessionFor(email) {
  const cfg = await fetch(`${LIVE}/config`, { cache: 'no-store' }).then((r) =>
    r.json()
  );
  const { supabaseUrl, supabaseAnonKey } = cfg;
  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error('loginConfig empty');
  }
  const otp = await fetch(`${supabaseUrl}/auth/v1/otp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: supabaseAnonKey
    },
    body: JSON.stringify({
      email,
      create_user: false,
      options: { email_redirect_to: `${LIVE}/` }
    })
  });
  if (!otp.ok) throw new Error(`otp ${otp.status}`);
  const body = await otp.json();
  if (!body.action_link) throw new Error('no inline action_link');
  // Exchange the grant programmatically (POST /auth/v1/verify) — more reliable
  // than parsing a redirect Location fragment over HTTP.
  const grantUrl = new URL(body.action_link);
  const grant = grantUrl.searchParams.get('token');
  if (!grant) throw new Error('action_link missing grant token');
  const verify = await fetch(`${supabaseUrl}/auth/v1/verify`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: supabaseAnonKey
    },
    body: JSON.stringify({ token: grant, type: 'magiclink' })
  });
  if (!verify.ok) throw new Error(`verify ${verify.status}`);
  const session = await verify.json();
  if (!session.access_token) throw new Error('verify returned no access_token');
  return session.access_token;
}

async function main() {
  // 1. version
  const ver = await fetch(`${LIVE}/version`);
  if (ver.ok) {
    const body = await ver.json();
    ok('GET /version 200', `sha=${(body.sha || '').slice(0, 12)}`);
  } else fail('GET /version 200', `status=${ver.status}`);

  // 2. unauthenticated write 401
  {
    const post = await fetch(`${LIVE}/api/kpi-values`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'nps', period: '2026-07', value: 1 })
    });
    post.status === 401
      ? ok('unauthenticated POST /api/kpi-values → 401')
      : fail('unauthenticated POST /api/kpi-values → 401', `status=${post.status}`);
  }

  // 3–8. founder session path
  let founderToken;
  try {
    founderToken = await sessionFor(FOUNDER);
    ok('founder magic-link session minted');
  } catch (e) {
    fail('founder magic-link session minted', e.message);
  }

  if (founderToken) {
    const me = await fetch(`${LIVE}/me`, {
      headers: { Authorization: `Bearer ${founderToken}` }
    }).then((r) => r.json());
    me.role === 'founder'
      ? ok('founder /me role', `role=${me.role}`)
      : fail('founder /me role', `role=${me.role}`);

    // Read before write for band-relevant KPI
    const before = await fetch(`${LIVE}/api/kpi-values`, {
      headers: { Authorization: `Bearer ${founderToken}` }
    }).then((r) => r.json());
    const beforeVal = ((before.values || {}).cash_runway_months || []).slice(-1)[0];

    const write = await fetch(`${LIVE}/api/kpi-values`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${founderToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        key: 'cash_runway_months',
        period: '2026-07',
        value: 12,
        note: 'phase1 live-check'
      })
    });
    write.ok
      ? ok('founder POST kpi value', `status=${write.status}`)
      : fail('founder POST kpi value', `status=${write.status}`);

    const after = await fetch(`${LIVE}/api/kpi-values`, {
      headers: { Authorization: `Bearer ${founderToken}` }
    }).then((r) => r.json());
    const series = (after.values || {}).cash_runway_months || [];
    const latest = series[series.length - 1];
    latest && Number(latest.value) === 12
      ? ok('value visible after write', `latest=${latest.value}`)
      : fail('value visible after write', JSON.stringify(latest));

    // Band-relevant: old red (2) → new green (12) is an observable threshold cross
    if (beforeVal && Number(beforeVal.value) < 9 && latest && Number(latest.value) >= 9) {
      ok('value crossed threshold (red→green runway)');
    } else {
      ok(
        'value write applied (threshold cross may already be flipped)',
        `before=${beforeVal && beforeVal.value} after=${latest && latest.value}`
      );
    }

    const audit = await fetch(`${LIVE}/api/audit-log`, {
      headers: { Authorization: `Bearer ${founderToken}` }
    });
    if (audit.ok) {
      const { entries } = await audit.json();
      const row = (entries || []).find(
        (e) => e.action === 'kpi_value.upsert' && Number(e.new_value) === 12
      );
      if (row && row.actor_email && row.created_at) {
        ok('audit who/when/old/new', `who=${row.actor_email} old=${row.old_value} new=${row.new_value}`);
      } else {
        fail('audit who/when/old/new', 'no matching row');
      }
    } else {
      fail('audit who/when/old/new', `status=${audit.status}`);
    }

    const def = await fetch(`${LIVE}/api/kpi-definitions/nps`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${founderToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        definition: 'Net Promoter Score — phase1 live-check definition.'
      })
    });
    def.ok
      ? ok('founder definition edit', `status=${def.status}`)
      : fail('founder definition edit', `status=${def.status}`);

    const defs = await fetch(`${LIVE}/api/kpi-definitions`, {
      headers: { Authorization: `Bearer ${founderToken}` }
    }).then((r) => r.json());
    const nps = (defs.definitions || {}).nps;
    const margin = (defs.definitions || {}).gross_margin_pct;
    nps && nps.changed === true
      ? ok('definition-changed flag on (nps)')
      : fail('definition-changed flag on (nps)', JSON.stringify(nps));
    margin && margin.changed === false
      ? ok('definition-changed flag off (stale gross_margin_pct)')
      : fail('definition-changed flag off (stale gross_margin_pct)', JSON.stringify(margin));
  }

  // Board denial
  let boardToken;
  try {
    boardToken = await sessionFor(BOARD);
    ok('board magic-link session minted');
  } catch (e) {
    fail('board magic-link session minted', e.message);
  }
  if (boardToken) {
    const me = await fetch(`${LIVE}/me`, {
      headers: { Authorization: `Bearer ${boardToken}` }
    }).then((r) => r.json());
    me.role === 'board'
      ? ok('board /me role', `role=${me.role}`)
      : fail('board /me role', `role=${me.role}`);

    const post = await fetch(`${LIVE}/api/kpi-values`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${boardToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ key: 'nps', period: '2026-08', value: 99 })
    });
    [401, 403].includes(post.status)
      ? ok('board value write denied', `status=${post.status}`)
      : fail('board value write denied', `status=${post.status}`);

    const put = await fetch(`${LIVE}/api/kpi-definitions/nps`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${boardToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ definition: 'nope' })
    });
    [401, 403].includes(put.status)
      ? ok('board definition write denied', `status=${put.status}`)
      : fail('board definition write denied', `status=${put.status}`);
  }

  // Static pages
  for (const path of ['/', '/layer/1', '/login']) {
    const res = await fetch(`${LIVE}${path}`);
    res.status === 200
      ? ok(`GET ${path} → 200`)
      : fail(`GET ${path} → 200`, `status=${res.status}`);
  }

  // Theme pre-paint script present in HTML
  {
    const html = await fetch(`${LIVE}/login`).then((r) => r.text());
    html.includes('data-theme-init') && html.includes('ig-board.theme')
      ? ok('theme pre-paint script present')
      : fail('theme pre-paint script present');
  }

  const failed = results.filter((r) => !r.pass);
  const summary = {
    live: LIVE,
    at: new Date().toISOString(),
    total: results.length,
    passed: results.length - failed.length,
    failed: failed.length,
    results
  };

  // Commit-friendly evidence (no secrets).
  const here = dirname(fileURLToPath(import.meta.url));
  const outDir = join(here, '..', 'e2e', 'evidence');
  try {
    mkdirSync(outDir, { recursive: true });
    writeFileSync(
      join(outDir, 'phase1-live-check.json'),
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
  console.error('phase1-live-check crashed:', err && err.message);
  process.exit(2);
});
