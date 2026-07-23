// Independent AI analysis — unit + inject tests.
// Covers: five sections, real KPI citation, simulate failure + retry,
// no key leakage, offline path when Anthropic unbound.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { buildApp } from '../src/server.js';
import { resetStore } from '../src/store.js';
import {
  resetMemosStore,
  createMemo,
  markAnalyzed
} from '../src/memosStore.js';
import {
  offlineAnalysis,
  buildKpiSnapshot,
  ensureFiveSections,
  isSimulateFailure,
  SECTION_HEADINGS,
  generateIndependentAnalysis,
  callAnthropic,
  SYSTEM_PROMPT,
  ANALYSIS_MODEL
} from '../src/independentAnalysis.js';
const TEST_KPI_VALUES = {
  bypass_count: [
    { period: '2026-06-01', value: 1 },
    { period: '2026-07-01', value: 3 }
  ]
};

const SECRET = 'analysis-test-jwt-secret';
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

function roleToken(role) {
  return signJwt({
    sub: `user-${role}`,
    email: `${role}.e2e@boardroom.test`,
    aud: 'authenticated',
    role: 'authenticated',
    app_metadata: { role },
    exp: now() + 3600
  });
}

test('SECTION_HEADINGS are the five required headings in order', () => {
  assert.deepEqual(SECTION_HEADINGS, [
    'Summary',
    'Claims vs Scorecard',
    'Slippage Watch',
    'Attribution Watch',
    'Questions the Board Should Ask'
  ]);
});

test('SYSTEM_PROMPT identifies rigorous-independent-board-analyst and model contract', () => {
  assert.match(SYSTEM_PROMPT, /rigorous-independent-board-analyst/);
  assert.match(SYSTEM_PROMPT, /Claims vs Scorecard/);
  assert.match(SYSTEM_PROMPT, /Slippage Watch/);
  assert.equal(ANALYSIS_MODEL, 'claude-sonnet-4-6');
});

test('buildKpiSnapshot uses latest values from a supplied series', () => {
  const snap = buildKpiSnapshot(TEST_KPI_VALUES);
  assert.ok(snap.bypass_count);
  assert.equal(snap.bypass_count.latest_value, 3);
  assert.equal(snap.bypass_count.name, 'Bypass Count');
  assert.ok(Array.isArray(snap.bypass_count.series));
  assert.equal(snap.bypass_count.series.length, 2);
});

test('offlineAnalysis emits five headings and cites a real KPI name+value', () => {
  const kpiSnapshot = buildKpiSnapshot(TEST_KPI_VALUES);
  const result = offlineAnalysis({
    kpiSnapshot,
    memos: [
      {
        id: 'm1',
        meeting_date: '2026-06-01',
        extracted_text:
          'Alex Rivera reports Project Atlas nearly complete. Cash runway is stable.'
      },
      {
        id: 'm2',
        meeting_date: '2026-07-01',
        extracted_text:
          'Alex Rivera says Project Atlas is still nearly complete. Will close next month.'
      }
    ]
  });
  const md = result.markdown;
  let last = -1;
  for (const h of SECTION_HEADINGS) {
    const idx = md.indexOf(`## ${h}`);
    assert.ok(idx >= 0, `missing heading ${h}`);
    assert.ok(idx > last, `heading ${h} out of order`);
    last = idx;
  }
  assert.match(md, /Bypass Count/);
  assert.match(md, /\b3\b/);
  assert.equal(result.source, 'offline');
});

test('ensureFiveSections appends missing Claims vs Scorecard with KPI cite', () => {
  const kpiSnapshot = buildKpiSnapshot(TEST_KPI_VALUES);
  const partial = '## Summary\n\nOnly summary.\n';
  const fixed = ensureFiveSections(partial, { kpiSnapshot });
  assert.match(fixed, /## Claims vs Scorecard/);
  assert.match(fixed, /Bypass Count/);
});

test('isSimulateFailure honors query, header, and body triggers', () => {
  assert.equal(
    isSimulateFailure({ query: { simulate_anthropic_failure: '1' } }),
    true
  );
  assert.equal(
    isSimulateFailure({
      headers: { 'x-simulate-anthropic-failure': 'true' }
    }),
    true
  );
  assert.equal(
    isSimulateFailure({ body: { simulateFailure: true } }),
    true
  );
  assert.equal(isSimulateFailure({ query: {}, headers: {}, body: {} }), false);
});

test('generateIndependentAnalysis uses offline path when key unbound', async () => {
  const result = await generateIndependentAnalysis({
    valuesByKey: TEST_KPI_VALUES,
    memos: [],
    env: {}
  });
  assert.equal(result.source, 'offline');
  assert.match(result.markdown, /## Claims vs Scorecard/);
  assert.match(result.markdown, /Bypass Count/);
});

test('callAnthropic posts to api.anthropic.com with model and system prompt', async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, opts });
    return {
      ok: true,
      async json() {
        return {
          id: 'msg_test',
          model: ANALYSIS_MODEL,
          content: [
            {
              type: 'text',
              text: [
                '## Summary',
                '',
                'Test summary.',
                '',
                '## Claims vs Scorecard',
                '',
                'Cash Runway (months) is 2.',
                '',
                '## Slippage Watch',
                '',
                'None.',
                '',
                '## Attribution Watch',
                '',
                'None.',
                '',
                '## Questions the Board Should Ask',
                '',
                '1. Why?'
              ].join('\n')
            }
          ]
        };
      }
    };
  };
  const result = await callAnthropic({
    system: SYSTEM_PROMPT,
    user: 'test',
    apiKey: 'sk-ant-test-not-real',
    fetchImpl
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.anthropic.com/v1/messages');
  const headers = calls[0].opts.headers;
  assert.equal(headers['x-api-key'], 'sk-ant-test-not-real');
  assert.equal(headers['anthropic-version'], '2023-06-01');
  const body = JSON.parse(calls[0].opts.body);
  assert.equal(body.model, 'claude-sonnet-4-6');
  assert.match(body.system, /rigorous-independent-board-analyst/);
  assert.match(result.markdown, /## Summary/);
});

test('POST /api/independent-analysis requires auth', async () => {
  process.env.SUPABASE_JWT_SECRET = SECRET;
  const app = buildApp({ logger: false });
  const res = await app.inject({
    method: 'POST',
    url: '/api/independent-analysis',
    payload: {}
  });
  assert.equal(res.statusCode, 401);
  await app.close();
});

test('POST /api/independent-analysis offline success cites KPI and five sections', async () => {
  process.env.SUPABASE_JWT_SECRET = SECRET;
  delete process.env.ANTHROPIC_API_KEY;
  resetStore();
  resetMemosStore();
  const memo = createMemo({
    authorId: 'user-founder',
    meetingDate: '2026-07-15',
    originalFilename: 'july.pdf',
    contentType: 'application/pdf',
    buffer: Buffer.from('%PDF-1.1 test')
  });
  markAnalyzed(
    memo.id,
    'Alex Rivera owns Project Atlas which is nearly complete. Runway concerns remain.'
  );

  const app = buildApp({ logger: false });
  const res = await app.inject({
    method: 'POST',
    url: '/api/independent-analysis',
    headers: { authorization: `Bearer ${roleToken('board')}` },
    payload: {}
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.ok, true);
  const md = body.analysis.markdown;
  let last = -1;
  for (const h of SECTION_HEADINGS) {
    const idx = md.indexOf(`## ${h}`);
    assert.ok(idx >= 0, `missing ${h}`);
    assert.ok(idx > last);
    last = idx;
  }
  assert.match(md, /Bypass Count/);
  assert.match(md, /\b2\b/);
  // Response body must never include the API key material.
  const raw = res.body;
  assert.doesNotMatch(raw, /sk-ant/);
  assert.doesNotMatch(raw, /api\.anthropic\.com/);
  await app.close();
});

test('POST /api/independent-analysis simulate failure then success on retry', async () => {
  process.env.SUPABASE_JWT_SECRET = SECRET;
  delete process.env.ANTHROPIC_API_KEY;
  resetStore();
  resetMemosStore();

  const app = buildApp({ logger: false });
  const headers = { authorization: `Bearer ${roleToken('founder')}` };

  const fail = await app.inject({
    method: 'POST',
    url: '/api/independent-analysis?simulate_anthropic_failure=1',
    headers,
    payload: {}
  });
  assert.equal(fail.statusCode, 503);
  const failBody = fail.json();
  assert.equal(failBody.error, 'anthropic_simulated_failure');
  assert.equal(failBody.retryable, true);
  assert.equal(failBody.simulate, true);

  const ok = await app.inject({
    method: 'POST',
    url: '/api/independent-analysis',
    headers,
    payload: {}
  });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.json().ok, true);
  assert.match(ok.json().analysis.markdown, /## Summary/);
  await app.close();
});

test('POST /api/independent-analysis works for founder and board', async () => {
  process.env.SUPABASE_JWT_SECRET = SECRET;
  delete process.env.ANTHROPIC_API_KEY;
  const app = buildApp({ logger: false });
  for (const role of ['founder', 'board']) {
    const res = await app.inject({
      method: 'POST',
      url: '/api/independent-analysis',
      headers: { authorization: `Bearer ${roleToken(role)}` },
      payload: {}
    });
    assert.equal(res.statusCode, 200, role);
  }
  await app.close();
});
