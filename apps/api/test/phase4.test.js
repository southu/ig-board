// Phase 4 acceptance tests: board CSV export + /whats-new digest cursor.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { buildApp } from '../src/server.js';
import { resetStore } from '../src/store.js';
import { kpiValuesToCsv } from '../src/csvExport.js';
import {
  consumeWhatsNew,
  getLastSeen,
  listChangesSince,
  resetWhatsNewStore
} from '../src/whatsNewStore.js';

const SECRET = 'phase4-test-jwt-secret';
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

function roleToken(role, email, sub) {
  return signJwt({
    sub: sub || `user-${role}`,
    email: email || `${role}.e2e@boardroom.test`,
    aud: 'authenticated',
    role: 'authenticated',
    app_metadata: { role },
    exp: now() + 3600
  });
}

async function makeApp() {
  const prev = {
    SUPABASE_JWT_SECRET: process.env.SUPABASE_JWT_SECRET,
    SUPABASE_URL: process.env.SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY
  };
  process.env.SUPABASE_JWT_SECRET = SECRET;
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  resetStore();
  resetWhatsNewStore();
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

test('kpiValuesToCsv emits header + data rows', () => {
  const csv = kpiValuesToCsv({
    cash_runway_months: [
      { period: '2026-06-01', value: 4 },
      { period: '2026-07-01', value: 2 }
    ],
    nps: [{ period: '2026-07-01', value: 55 }]
  });
  const lines = csv.trim().split('\n');
  assert.equal(lines[0], 'kpi_key,period,value');
  assert.ok(lines.length >= 4);
  assert.ok(lines.some((l) => l.startsWith('cash_runway_months,')));
  assert.ok(lines.some((l) => l.startsWith('nps,')));
});

test('board can download CSV of all kpi_values (text/csv + header + rows)', async (t) => {
  const app = await makeApp();
  t.after(() => {
    app.close();
    app.__restore();
  });
  const res = await app.inject({
    method: 'GET',
    url: '/api/export/kpi-values.csv',
    headers: { authorization: `Bearer ${roleToken('board')}` }
  });
  assert.equal(res.statusCode, 200);
  const ct = res.headers['content-type'] || '';
  assert.match(ct, /text\/csv/i);
  const body = res.body;
  const lines = body.trim().split('\n');
  assert.equal(lines[0], 'kpi_key,period,value');
  assert.ok(lines.length > 1, 'expected data rows from seed');
  assert.ok(body.includes('cash_runway_months'));
});

test('founder is denied CSV export (403)', async (t) => {
  const app = await makeApp();
  t.after(() => {
    app.close();
    app.__restore();
  });
  const res = await app.inject({
    method: 'GET',
    url: '/api/export/kpi-values.csv',
    headers: { authorization: `Bearer ${roleToken('founder')}` }
  });
  assert.equal(res.statusCode, 403);
});

test('unauthenticated CSV export is 401', async (t) => {
  const app = await makeApp();
  t.after(() => {
    app.close();
    app.__restore();
  });
  const res = await app.inject({
    method: 'GET',
    url: '/api/export/kpi-values.csv'
  });
  assert.equal(res.statusCode, 401);
});

test('whats-new lists changes after last_seen_at; revisit is empty', async (t) => {
  const app = await makeApp();
  t.after(() => {
    app.close();
    app.__restore();
  });
  const token = roleToken('board', 'board.e2e@boardroom.test', 'board-user-1');

  const first = await app.inject({
    method: 'GET',
    url: '/api/whats-new',
    headers: { authorization: `Bearer ${token}` }
  });
  assert.equal(first.statusCode, 200);
  const firstBody = first.json();
  assert.equal(firstBody.last_seen_at, null);
  assert.ok(Array.isArray(firstBody.items));
  assert.ok(firstBody.items.length > 0, 'first visit should list seed changes');
  assert.ok(firstBody.seen_at);

  const second = await app.inject({
    method: 'GET',
    url: '/api/whats-new',
    headers: { authorization: `Bearer ${token}` }
  });
  assert.equal(second.statusCode, 200);
  const secondBody = second.json();
  assert.equal(secondBody.last_seen_at, firstBody.seen_at);
  assert.ok(
    secondBody.items.length < firstBody.items.length ||
      secondBody.items.length === 0,
    'revisit should be empty or reduced'
  );
  assert.equal(secondBody.items.length, 0);
});

test('whats-new surfaces new founder writes after a prior visit', async (t) => {
  const app = await makeApp();
  t.after(() => {
    app.close();
    app.__restore();
  });
  const boardTok = roleToken('board', 'board.e2e@boardroom.test', 'board-user-2');
  const founderTok = roleToken('founder');

  // Prime the board cursor.
  await app.inject({
    method: 'GET',
    url: '/api/whats-new',
    headers: { authorization: `Bearer ${boardTok}` }
  });

  // Founder writes a new value.
  const write = await app.inject({
    method: 'POST',
    url: '/api/kpi-values',
    headers: { authorization: `Bearer ${founderTok}` },
    payload: { key: 'nps', period: '2026-08', value: 61, note: 'phase4' }
  });
  assert.equal(write.statusCode, 200);

  const digest = await app.inject({
    method: 'GET',
    url: '/api/whats-new',
    headers: { authorization: `Bearer ${boardTok}` }
  });
  assert.equal(digest.statusCode, 200);
  const body = digest.json();
  assert.ok(body.items.length >= 1);
  const summaries = body.items.map((i) => i.summary).join(' ');
  assert.match(summaries, /nps|kpi_value/i);
});

test('consumeWhatsNew advances last_seen_at', () => {
  resetWhatsNewStore();
  resetStore();
  const r1 = consumeWhatsNew('u-test');
  assert.equal(r1.last_seen_at, null);
  assert.ok(r1.items.length > 0);
  assert.equal(getLastSeen('u-test'), r1.seen_at);
  const r2 = consumeWhatsNew('u-test');
  assert.equal(r2.last_seen_at, r1.seen_at);
  assert.equal(r2.items.length, 0);
  // listChangesSince with far-future cursor is empty
  assert.equal(listChangesSince('2099-01-01T00:00:00.000Z').length, 0);
});

test('whats-new payload has no email/mailto/subscribe chrome fields', async (t) => {
  const app = await makeApp();
  t.after(() => {
    app.close();
    app.__restore();
  });
  const res = await app.inject({
    method: 'GET',
    url: '/api/whats-new',
    headers: { authorization: `Bearer ${roleToken('founder')}` }
  });
  assert.equal(res.statusCode, 200);
  const text = res.body;
  assert.doesNotMatch(text, /mailto:/i);
  assert.doesNotMatch(text, /subscribe/i);
  assert.doesNotMatch(text, /notification/i);
  const body = res.json();
  assert.ok(!('email' in body));
  assert.ok(!('mailto' in body));
});
