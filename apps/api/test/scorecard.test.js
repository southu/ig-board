import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { buildApp } from '../src/server.js';

const SECRET = 'scorecard-test-secret';
const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');

function token() {
  const header = b64({ alg: 'HS256', typ: 'JWT' });
  const payload = b64({
    sub: 'scorecard-reader',
    email: 'board.e2e@boardroom.test',
    role: 'authenticated',
    app_metadata: { role: 'board' },
    exp: Math.floor(Date.now() / 1000) + 3600
  });
  const signature = crypto
    .createHmac('sha256', SECRET)
    .update(`${header}.${payload}`)
    .digest('base64url');
  return `${header}.${payload}.${signature}`;
}

test('GET /api/scorecard returns the exact replacement catalog', async (t) => {
  const previous = process.env.SUPABASE_JWT_SECRET;
  process.env.SUPABASE_JWT_SECRET = SECRET;
  const app = buildApp({ logger: false });
  await app.ready();
  t.after(async () => {
    await app.close();
    if (previous === undefined) delete process.env.SUPABASE_JWT_SECRET;
    else process.env.SUPABASE_JWT_SECRET = previous;
  });

  const response = await app.inject({
    method: 'GET',
    url: '/api/scorecard',
    headers: { authorization: `Bearer ${token()}` }
  });
  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.layers.length, 5);
  assert.deepEqual(body.layers.map((layer) => layer.position), [1, 2, 3, 4, 5]);
  assert.deepEqual(body.layers.map((layer) => layer.type), [
    'MANAGE', 'MANAGE', 'MANAGE', 'MONITOR', 'MONITOR'
  ]);
  assert.equal(body.kpis.length, 14);
  assert.deepEqual(body.kpis.map((kpi) => kpi.code), [
    '1.1', '1.2', '1.3', '2.1', '2.2', '2.3', '3.1',
    '3.2', '3.3', '4.1', '4.2', '4.3', '5.1', '5.2'
  ]);
  assert.ok(body.kpis.every((kpi) => kpi.definition && kpi.owner && kpi.cadence));
  assert.ok(body.kpis.every((kpi) => kpi.owner !== 'VP People'));

  const bypass = body.kpis.find((kpi) => kpi.code === '1.2');
  assert.deepEqual(bypass.thresholds, {
    green: '0',
    yellow: '1–2',
    red: '3+ or any override without written rationale'
  });
  assert.equal(bypass.baseline, 'unknown — never counted');
  assert.equal(bypass.definition_note, 'The single most important number on this scorecard.');

  const byCode = new Map(body.kpis.map((kpi) => [kpi.code, kpi]));
  assert.equal(byCode.get('1.1').owner, 'Zack & Jon jointly');
  assert.equal(
    byCode.get('2.1').owner,
    'External survey tool — results delivered to board and founders simultaneously'
  );
  assert.equal(
    byCode.get('3.3').owner,
    'Enablement/ops owner once hired; Allison until then'
  );
  assert.equal(byCode.get('3.1').baseline_source, 'Rinnai/Fortune Brands');
  assert.equal(
    byCode.get('4.2').baseline_source,
    'Jan–May core NOI –$70K 2024, $258K 2025, $354K 2026'
  );
  assert.equal(
    byCode.get('2.3').verification,
    'sample two documents at random per quarter'
  );
  assert.deepEqual(
    body.kpis.filter((kpi) => kpi.definition_note).map((kpi) => kpi.code),
    ['1.2', '2.2', '3.2', '4.2', '4.3', '5.2']
  );

  const layer5 = body.kpis.filter((kpi) => kpi.layer_position === 5);
  assert.equal(layer5.length, 2);
  assert.equal(layer5[1].type, 'computed');
  assert.equal(layer5[1].manual_entry, false);

  assert.equal(body.watch_items.length, 1);
  assert.equal(body.watch_items[0].type, 'special_watch_item');
  assert.equal(body.watch_items[0].layer_position, 2);
  assert.equal(body.watch_items[0].thresholds.green, '0');
});
