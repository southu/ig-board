// Phase 3 agenda generator — unit + HTTP surface tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { buildApp } from '../src/server.js';
import { resetAgendaStore, getAgenda, setEditedContent } from '../src/agendaStore.js';
import {
  resetCommentsStore,
  createComment,
  setResolved
} from '../src/commentsStore.js';
import {
  computeStatus,
  extractBoardQuestions,
  sortTopicsBottomUp,
  topicsFromKpis,
  topicsFromComments,
  topicsFromQuestions,
  generateAgendaContent,
  latestValue
} from '../src/agendaGenerate.js';
import { AGENDA_LAYERS, agendaLayerName } from '../src/agendaLayers.js';
import { SEED_KPI_VALUES } from '../src/seedData.js';

const SECRET = 'agenda-test-jwt-secret';
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
  const prev = process.env.SUPABASE_JWT_SECRET;
  process.env.SUPABASE_JWT_SECRET = SECRET;
  // Keep analysis offline for deterministic tests.
  const prevKey = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  resetAgendaStore();
  resetCommentsStore();
  const app = buildApp({ logger: false });
  await app.ready();
  app._restore = () => {
    if (prev === undefined) delete process.env.SUPABASE_JWT_SECRET;
    else process.env.SUPABASE_JWT_SECRET = prev;
    if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = prevKey;
  };
  return app;
}

test('agenda layers: Leadership Alignment is 1, Revenue Growth before Enterprise Value', () => {
  assert.equal(agendaLayerName(1), 'Leadership Alignment');
  assert.equal(agendaLayerName(3), 'Revenue Growth');
  assert.equal(agendaLayerName(5), 'Enterprise Value');
  assert.equal(AGENDA_LAYERS[0].position, 1);
  assert.equal(AGENDA_LAYERS[AGENDA_LAYERS.length - 1].name, 'Enterprise Value');
});

test('computeStatus: seed cash runway is red, gross margin yellow', () => {
  const cash = {
    key: 'cash_runway_months',
    direction: 'up_good',
    green: 9,
    yellow: 6,
    red: 3
  };
  const margin = {
    key: 'gross_margin_pct',
    direction: 'up_good',
    green: 38,
    yellow: 34,
    red: 30
  };
  assert.equal(computeStatus(2, cash), 'red');
  assert.equal(computeStatus(37, margin), 'yellow');
  assert.equal(computeStatus(12, { direction: 'up_good', green: 12, yellow: 8, red: 5 }), 'green');
});

test('extractBoardQuestions pulls numbered items from analysis markdown', () => {
  const md = `## Summary
Hello

## Questions the Board Should Ask

1. What is the path for cash runway?
2. Who owns red KPIs?
3. Short
- A longer question about concentration risk that should count.
`;
  const qs = extractBoardQuestions(md);
  assert.ok(qs.length >= 2);
  assert.ok(qs[0].includes('cash runway'));
});

test('sortTopicsBottomUp: layer 1 before layer 4/5', () => {
  const sorted = sortTopicsBottomUp([
    { layer: 5, source: 'kpi', title: 'EV' },
    { layer: 1, source: 'kpi', title: 'LA' },
    { layer: 4, source: 'kpi', title: 'RG-ish' },
    { layer: 3, source: 'kpi', title: 'Rev' }
  ]);
  assert.equal(sorted[0].layer, 1);
  assert.equal(sorted[0].title, 'LA');
  const last = sorted[sorted.length - 1];
  assert.equal(last.layer, 5);
});

test('topicsFromKpis includes only red/yellow from seed values', () => {
  const topics = topicsFromKpis(SEED_KPI_VALUES);
  assert.ok(topics.length >= 1);
  for (const t of topics) {
    assert.ok(t.status === 'red' || t.status === 'yellow');
    assert.equal(t.source, 'kpi');
  }
  const cash = topics.find((t) => t.kpi_key === 'cash_runway_months');
  assert.ok(cash);
  assert.equal(cash.layer, 1);
  assert.equal(cash.layer_name, 'Leadership Alignment');
});

test('topicsFromComments skips resolved; keeps unresolved roots', () => {
  resetCommentsStore();
  const open = createComment({
    body: 'Please discuss cash runway with the board @cfo',
    authorId: 'u1',
    kpiId: 'cash_runway_months'
  });
  const closed = createComment({
    body: 'This was already handled',
    authorId: 'u1',
    kpiId: 'gross_margin_pct'
  });
  setResolved(closed.id, true);
  createComment({
    body: 'reply should not be a topic',
    authorId: 'u2',
    parentId: open.id
  });

  const topics = topicsFromComments([
    // list via store public shape
    { ...open, resolved: false, parent_id: null },
    { id: closed.id, body: closed.body, resolved: true, parent_id: null, kpi_id: 'gross_margin_pct' },
    { id: 'reply', body: 'reply', resolved: false, parent_id: open.id, kpi_id: 'cash_runway_months' }
  ]);
  assert.equal(topics.length, 1);
  assert.equal(topics[0].comment_id, open.id);
  assert.ok(topics[0].body.includes('cash runway'));
});

test('generateAgendaContent: time-blocked, ordered, multi-source', async () => {
  resetCommentsStore();
  createComment({
    body: 'Open thread on runway for the agenda',
    authorId: 'u1',
    kpiId: 'cash_runway_months'
  });
  // Need unresolved list shape
  const { listUnresolvedComments } = await import('../src/commentsStore.js');
  const content = await generateAgendaContent({
    valuesByKey: SEED_KPI_VALUES,
    comments: listUnresolvedComments(),
    memos: [],
    env: {}
  });
  assert.ok(Array.isArray(content.topics));
  assert.ok(content.topics.length >= 3); // kpi + comment + questions
  assert.ok(content.topics.every((t) => t.time_block && t.start_time));
  // First Leadership Alignment before any Revenue Growth / Enterprise Value
  const firstLa = content.topics.findIndex(
    (t) => t.layer_name === 'Leadership Alignment'
  );
  const firstHigh = content.topics.findIndex(
    (t) =>
      t.layer_name === 'Revenue Growth' || t.layer_name === 'Enterprise Value'
  );
  assert.ok(firstLa >= 0);
  if (firstHigh >= 0) {
    assert.ok(firstLa < firstHigh);
  }
  // Layer order non-decreasing
  for (let i = 1; i < content.topics.length; i++) {
    assert.ok(content.topics[i].layer >= content.topics[i - 1].layer);
  }
  assert.ok(content.sources.red_yellow_kpis >= 1);
  assert.ok(content.sources.unresolved_comments >= 1);
  assert.ok(content.sources.analysis_questions >= 1);
});

test('GET /api/agenda requires auth', async (t) => {
  const app = await makeApp();
  t.after(() => {
    app._restore();
    return app.close();
  });
  const res = await app.inject({ method: 'GET', url: '/api/agenda' });
  assert.equal(res.statusCode, 401);
});

test('GET /api/agenda returns time-blocked topics for founder', async (t) => {
  const app = await makeApp();
  t.after(() => {
    app._restore();
    return app.close();
  });
  const res = await app.inject({
    method: 'GET',
    url: '/api/agenda',
    headers: { authorization: `Bearer ${roleToken('founder')}` }
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.ok(body.agenda);
  assert.ok(body.agenda.generated_content);
  assert.ok(Array.isArray(body.agenda.generated_content.topics));
  assert.equal(body.agenda.edited_content, null);
  const topics = body.agenda.generated_content.topics;
  assert.ok(topics.length >= 1);
  assert.ok(topics.every((t) => typeof t.time_block === 'string'));
  // Leadership Alignment first among layer-named topics
  const names = topics.map((t) => t.layer_name);
  const la = names.indexOf('Leadership Alignment');
  const rev = names.indexOf('Revenue Growth');
  const ev = names.indexOf('Enterprise Value');
  if (la >= 0 && rev >= 0) assert.ok(la < rev);
  if (la >= 0 && ev >= 0) assert.ok(la < ev);
});

test('PATCH edited_content preserves generated; regenerate keeps edit', async (t) => {
  const app = await makeApp();
  t.after(() => {
    app._restore();
    return app.close();
  });
  const token = roleToken('founder');
  const auth = { authorization: `Bearer ${token}` };

  const first = await app.inject({ method: 'GET', url: '/api/agenda', headers: auth });
  assert.equal(first.statusCode, 200);
  const genBefore = first.json().agenda.generated_content;
  assert.ok(genBefore);
  assert.ok(genBefore.topics.length >= 1);

  const editText = 'FOUNDER EDIT MARKER — do not clobber';
  const patched = await app.inject({
    method: 'PATCH',
    url: '/api/agenda',
    headers: auth,
    payload: { edited_content: editText }
  });
  assert.equal(patched.statusCode, 200);
  const afterEdit = patched.json().agenda;
  assert.equal(afterEdit.edited_content, editText);
  assert.deepEqual(afterEdit.generated_content, genBefore);

  // Add a comment, regenerate — edit stays, generation may change.
  await app.inject({
    method: 'POST',
    url: '/api/comments',
    headers: auth,
    payload: {
      body: 'Brand new unresolved for regen',
      kpi_id: 'cash_runway_months'
    }
  });

  const regen = await app.inject({
    method: 'POST',
    url: '/api/agenda/regenerate',
    headers: auth,
    payload: {}
  });
  assert.equal(regen.statusCode, 200);
  const afterRegen = regen.json().agenda;
  assert.equal(afterRegen.edited_content, editText);
  assert.ok(afterRegen.generated_content);
  assert.ok(afterRegen.generated_content.topics.length >= 1);
  // generated is still present (and may differ) — not nullified by edit path
  assert.notEqual(afterRegen.generated_content, null);
});

test('resolved comment excluded on regenerate; unresolved included', async (t) => {
  const app = await makeApp();
  t.after(() => {
    app._restore();
    return app.close();
  });
  const token = roleToken('founder');
  const auth = { authorization: `Bearer ${token}` };

  const created = await app.inject({
    method: 'POST',
    url: '/api/comments',
    headers: auth,
    payload: {
      body: 'UNIQUE_AGENDA_COMMENT_XYZ for resolve gating',
      kpi_id: 'cash_runway_months'
    }
  });
  assert.equal(created.statusCode, 201);
  const commentId = created.json().comment.id;

  const withOpen = await app.inject({
    method: 'POST',
    url: '/api/agenda/regenerate',
    headers: auth,
    payload: {}
  });
  assert.equal(withOpen.statusCode, 200);
  const topicsOpen = withOpen.json().agenda.generated_content.topics;
  const foundOpen = topicsOpen.some(
    (t) =>
      t.comment_id === commentId ||
      (t.body && t.body.includes('UNIQUE_AGENDA_COMMENT_XYZ'))
  );
  assert.ok(foundOpen, 'unresolved comment should appear as agenda topic');

  const resolved = await app.inject({
    method: 'PATCH',
    url: `/api/comments/${commentId}`,
    headers: auth,
    payload: { resolved: true }
  });
  assert.equal(resolved.statusCode, 200);

  const afterResolve = await app.inject({
    method: 'POST',
    url: '/api/agenda/regenerate',
    headers: auth,
    payload: {}
  });
  assert.equal(afterResolve.statusCode, 200);
  const topicsClosed = afterResolve.json().agenda.generated_content.topics;
  const foundClosed = topicsClosed.some(
    (t) =>
      t.comment_id === commentId ||
      (t.body && t.body.includes('UNIQUE_AGENDA_COMMENT_XYZ'))
  );
  assert.equal(foundClosed, false, 'resolved comment must not appear after regenerate');
});

test('board can read agenda; board cannot PATCH edit', async (t) => {
  const app = await makeApp();
  t.after(() => {
    app._restore();
    return app.close();
  });
  // Seed with founder first
  await app.inject({
    method: 'GET',
    url: '/api/agenda',
    headers: { authorization: `Bearer ${roleToken('founder')}` }
  });

  const boardGet = await app.inject({
    method: 'GET',
    url: '/api/agenda',
    headers: { authorization: `Bearer ${roleToken('board')}` }
  });
  assert.equal(boardGet.statusCode, 200);

  const boardPatch = await app.inject({
    method: 'PATCH',
    url: '/api/agenda',
    headers: { authorization: `Bearer ${roleToken('board')}` },
    payload: { edited_content: 'board should not write' }
  });
  assert.equal(boardPatch.statusCode, 403);
});

test('latestValue picks last period', () => {
  assert.equal(latestValue([{ period: 'a', value: 1 }, { period: 'b', value: 9 }]), 9);
  assert.equal(latestValue([]), null);
});

test('topicsFromQuestions assign Leadership Alignment layer', () => {
  const t = topicsFromQuestions(['Why is runway red?', 'Who owns margin?']);
  assert.equal(t.length, 2);
  assert.ok(t.every((x) => x.layer === 1 && x.layer_name === 'Leadership Alignment'));
});

// silence unused import lint when tree-shaken in some runners
void setEditedContent;
void getAgenda;
