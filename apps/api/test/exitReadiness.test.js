import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { buildApp } from '../src/server.js';
import { resetStore } from '../src/store.js';
import {
  computeExitReadiness,
  EXIT_READINESS_NOTE
} from '../src/exitReadiness.js';

const SECRET = 'exit-readiness-test-secret';
const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');

function founderToken() {
  const header = b64({ alg: 'HS256', typ: 'JWT' });
  const payload = b64({
    sub: 'exit-readiness-founder',
    email: 'founder.e2e@boardroom.test',
    role: 'authenticated',
    app_metadata: { role: 'founder' },
    exp: Math.floor(Date.now() / 1000) + 3600
  });
  const signature = crypto
    .createHmac('sha256', SECRET)
    .update(`${header}.${payload}`)
    .digest('base64url');
  return `${header}.${payload}.${signature}`;
}

test('exit readiness counts current green statuses and positive 5.1 history trend', () => {
  const result = computeExitReadiness({
    customer_concentration: [{ period: '2026-06-01', value: 20 }],
    time_to_first_revenue: [{ period: '2026-06-01', value: 6 }],
    founder_intervention_count: [{ period: '2026-06-01', value: 0 }],
    core_net_ordinary_income: [{ period: '2026-06-01', value: 1000000 }],
    adjusted_ebitda_ttm: [
      { period: '2026-03-01', value: 100000 },
      { period: '2026-06-01', value: 150000 }
    ]
  });

  assert.equal(result.value, '4 of 4 conditions met');
  assert.equal(result.score, 4);
  assert.equal(result.count, 4);
  assert.equal(result.status, 'green');
  assert.ok(result.conditions.every((condition) => condition.met));
  assert.equal(result.definition_note, EXIT_READINESS_NOTE);
});

test('5.2 recomputes after underlying writes and rejects direct writes', async (t) => {
  const previous = {
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
  t.after(async () => {
    await app.close();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const headers = { authorization: `Bearer ${founderToken()}` };

  async function readScore() {
    const response = await app.inject({
      method: 'GET',
      url: '/api/kpi-values',
      headers
    });
    assert.equal(response.statusCode, 200);
    return response.json().values.exit_readiness_score[0];
  }

  assert.equal((await readScore()).score, 0);

  const underlyingWrite = await app.inject({
    method: 'POST',
    url: '/api/kpi-values',
    headers,
    payload: {
      key: 'customer_concentration',
      period: '2026-07',
      value: 20
    }
  });
  assert.equal(underlyingWrite.statusCode, 200);
  const after = await readScore();
  assert.equal(after.score, 1);
  assert.equal(
    after.conditions.find((condition) => condition.key === 'concentration_cap').met,
    true
  );

  const directWrite = await app.inject({
    method: 'POST',
    url: '/api/kpi-values',
    headers,
    payload: {
      key: 'exit_readiness_score',
      period: '2026-07',
      value: 4,
      status: 'green'
    }
  });
  assert.equal(directWrite.statusCode, 400);
  assert.match(directWrite.json().message, /computed KPI/i);
  assert.equal((await readScore()).score, 1);
});
