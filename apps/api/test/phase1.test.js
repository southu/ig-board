// Phase 1 acceptance tests: founder KPI entry, definition editing, the audit
// trail, and the board write denial — driven through the real Fastify surface
// via app.inject(). Mirrors the live tester's checks against Railway.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { buildApp } from '../src/server.js';
import { resetStore } from '../src/store.js';

const SECRET = 'phase1-test-jwt-secret';
const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
const now = () => Math.floor(Date.now() / 1000);

function signJwt(payload, secret = SECRET) {
  const header = b64({ alg: 'HS256', typ: 'JWT' });
  const body = b64(payload);
  const sig = crypto
    .createHmac('sha256', secret)
    .update(`${header}.${body}`)
    .digest('base64url');
  return `${header}.${body}.${sig}`;
}

function roleToken(role, email) {
  return signJwt({
    sub: `user-${role}`,
    email: email || `${role}.e2e@boardroom.test`,
    aud: 'authenticated',
    role: 'authenticated',
    app_metadata: { role },
    exp: now() + 3600
  });
}

async function makeApp() {
  // No external Supabase project — the store is the authority (the live state).
  const prev = {
    SUPABASE_JWT_SECRET: process.env.SUPABASE_JWT_SECRET,
    SUPABASE_URL: process.env.SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY
  };
  process.env.SUPABASE_JWT_SECRET = SECRET;
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  resetStore();
  const app = buildApp({ logger: false });
  await app.ready();
  app.__restore = () => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
  return app;
}

test('founder can submit a KPI value (period YYYY-MM, value, note)', async (t) => {
  const app = await makeApp();
  t.after(() => {
    app.close();
    app.__restore();
  });
  const res = await app.inject({
    method: 'POST',
    url: '/api/kpi-values',
    headers: { authorization: `Bearer ${roleToken('founder')}` },
    payload: { key: 'nps', period: '2026-07', value: 60, note: 'Q3 survey' }
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().ok, true);
  assert.equal(res.json().value.period, '2026-07-01');

  // It shows up in the merged read immediately.
  const read = await app.inject({
    method: 'GET',
    url: '/api/kpi-values',
    headers: { authorization: `Bearer ${roleToken('founder')}` }
  });
  const series = read.json().values.nps;
  assert.ok(Array.isArray(series) && series.length >= 1);
  assert.equal(series[series.length - 1].value, 60);
});

test('board session token is denied (403) on KPI value write', async (t) => {
  const app = await makeApp();
  t.after(() => {
    app.close();
    app.__restore();
  });
  const res = await app.inject({
    method: 'POST',
    url: '/api/kpi-values',
    headers: { authorization: `Bearer ${roleToken('board')}` },
    payload: { key: 'nps', period: '2026-07', value: 99 }
  });
  assert.equal(res.statusCode, 403);
});

test('board session token is denied (403) on definition edit', async (t) => {
  const app = await makeApp();
  t.after(() => {
    app.close();
    app.__restore();
  });
  const res = await app.inject({
    method: 'PUT',
    url: '/api/kpi-definitions/nps',
    headers: { authorization: `Bearer ${roleToken('board')}` },
    payload: { definition: 'board should not be able to set this' }
  });
  assert.equal(res.statusCode, 403);
});

test('unauthenticated write attempts fail closed with 401', async (t) => {
  const app = await makeApp();
  t.after(() => {
    app.close();
    app.__restore();
  });
  const post = await app.inject({
    method: 'POST',
    url: '/api/kpi-values',
    payload: { key: 'nps', period: '2026-07', value: 1 }
  });
  assert.equal(post.statusCode, 401);
  const put = await app.inject({
    method: 'PUT',
    url: '/api/kpi-definitions/nps',
    payload: { definition: 'x' }
  });
  assert.equal(put.statusCode, 401);
});

test('audit log records who/when/old/new for a value change (founder-only)', async (t) => {
  const app = await makeApp();
  t.after(() => {
    app.close();
    app.__restore();
  });
  const founder = roleToken('founder', 'founder.e2e@boardroom.test');
  // First write establishes a value; second changes it so old != new.
  await app.inject({
    method: 'POST',
    url: '/api/kpi-values',
    headers: { authorization: `Bearer ${founder}` },
    payload: { key: 'nps', period: '2026-07', value: 60 }
  });
  await app.inject({
    method: 'POST',
    url: '/api/kpi-values',
    headers: { authorization: `Bearer ${founder}` },
    payload: { key: 'nps', period: '2026-07', value: 20 }
  });

  const audit = await app.inject({
    method: 'GET',
    url: '/api/audit-log',
    headers: { authorization: `Bearer ${founder}` }
  });
  assert.equal(audit.statusCode, 200);
  const entries = audit.json().entries;
  assert.ok(entries.length >= 2, 'two value changes recorded');
  const latest = entries[0]; // newest first
  assert.equal(latest.actor_email, 'founder.e2e@boardroom.test'); // who
  assert.ok(latest.created_at, 'when');
  assert.equal(latest.old_value, 60); // old
  assert.equal(latest.new_value, 20); // new

  // Board cannot read the audit view.
  const boardAudit = await app.inject({
    method: 'GET',
    url: '/api/audit-log',
    headers: { authorization: `Bearer ${roleToken('board')}` }
  });
  assert.equal(boardAudit.statusCode, 403);
});

test('definition edit sets the 90-day changed flag; a stale seed does not', async (t) => {
  const app = await makeApp();
  t.after(() => {
    app.close();
    app.__restore();
  });
  const founder = roleToken('founder');
  await app.inject({
    method: 'PUT',
    url: '/api/kpi-definitions/nps',
    headers: { authorization: `Bearer ${founder}` },
    payload: { definition: 'Net Promoter Score, quarterly customer survey.' }
  });

  const defs = await app.inject({
    method: 'GET',
    url: '/api/kpi-definitions',
    headers: { authorization: `Bearer ${roleToken('board')}` }
  });
  assert.equal(defs.statusCode, 200);
  const map = defs.json().definitions;
  // Freshly edited -> flag on.
  assert.equal(map.nps.changed, true);
  // Seeded stale (2020) -> flag off (older than 90 days).
  assert.equal(map.gross_margin_pct.changed, false);

  // The edit is auditable (who/when/old/new).
  const audit = await app.inject({
    method: 'GET',
    url: '/api/audit-log',
    headers: { authorization: `Bearer ${founder}` }
  });
  const defRow = audit.json().entries.find((e) => e.action === 'kpi_definition.update');
  assert.ok(defRow, 'definition edit recorded in audit');
  assert.equal(defRow.new_value, 'Net Promoter Score, quarterly customer survey.');
});

test('malformed founder value writes fail closed with 400', async (t) => {
  const app = await makeApp();
  t.after(() => {
    app.close();
    app.__restore();
  });
  const founder = roleToken('founder');
  const bad = (payload) =>
    app.inject({
      method: 'POST',
      url: '/api/kpi-values',
      headers: { authorization: `Bearer ${founder}` },
      payload
    });
  assert.equal((await bad({ period: '2026-07', value: 1 })).statusCode, 400); // no key
  assert.equal((await bad({ key: 'nps', period: 'nope', value: 1 })).statusCode, 400); // bad period
  assert.equal((await bad({ key: 'nps', period: '2026-07', value: 'x' })).statusCode, 400); // NaN
});
