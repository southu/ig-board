// Agenda generator — assemble a time-blocked board agenda from:
//   1. Red / yellow KPIs (watch + off-track)
//   2. Unresolved comments (resolved comments are excluded)
//   3. Latest independent analysis "Questions the Board Should Ask"
//
// Topics are ordered bottom-up through the agenda pyramid: layer 1
// (Leadership Alignment) first → layer 5 (Enterprise Value) last.
// Within a layer: KPIs, then comments, then analysis questions; stable sort.

import crypto from 'node:crypto';
import {
  AGENDA_LAYERS,
  agendaLayerName,
  catalogLayerToAgenda
} from './agendaLayers.js';
import {
  generateIndependentAnalysis,
  SECTION_HEADINGS
} from './independentAnalysis.js';
import {
  SCORECARD_KPIS,
  SCORECARD_LAYERS,
  SCORECARD_WATCH_ITEMS
} from './scorecardData.js';

// Runtime RAG metadata is kept separate from the authoritative KPI identity
// fields. Agenda KPI codes, names, and layers always come from scorecardData.
const KPI_RUNTIME = {
  decision_rights_map_completion: { direction: 'up_good', unit: '%', green: 100, yellow: null, red: null },
  bypass_count: { direction: 'down_good', unit: 'count', green: 0, yellow: 2, red: 3 },
  joint_priorities_document_current: { direction: 'up_good', unit: 'status', green: 1, yellow: null, red: null },
  role_clarity_score: { direction: 'up_good', unit: '%', green: 80, yellow: 65, red: null },
  survey_response_rate: { direction: 'up_good', unit: '%', green: 85, yellow: 70, red: null },
  success_criteria_coverage: { direction: 'up_good', unit: '%', green: 100, yellow: null, red: null },
  time_to_first_revenue: { direction: 'down_good', unit: 'months', green: 6, yellow: 12, red: null },
  founder_intervention_count: { direction: 'down_good', unit: 'count', green: 0, yellow: 1, red: 2 },
  customer_touches_per_order: { direction: 'down_good', unit: 'touches', green: 6, yellow: 9, red: 10 },
  revenue_vs_plan: { direction: 'up_good', unit: '%', green: 97, yellow: 90, red: null },
  core_net_ordinary_income: { direction: 'up_good', unit: 'USD', green: 1000000, yellow: null, red: null },
  customer_concentration: { direction: 'down_good', unit: '%', green: 20, yellow: 30, red: null },
  adjusted_ebitda_ttm: { direction: 'up_good', unit: 'USD', green: null, yellow: null, red: null },
  exit_readiness_score: { direction: 'up_good', unit: 'score', green: null, yellow: null, red: null }
};

export const KPI_CATALOG = SCORECARD_KPIS.map((kpi) => ({
  code: kpi.code,
  key: kpi.key,
  name: kpi.name,
  layer: kpi.layer_position,
  ...KPI_RUNTIME[kpi.key]
}));

const KPI_BY_KEY = new Map(KPI_CATALOG.map((k) => [k.key, k]));
const RETIRED_KPI_NAMES = [
  'Revenue Plan FY1',
  'Revenue Plan FY2',
  'Revenue Plan FY3',
  'Gross Margin %',
  'EBITDA Margin %',
  'Cash Runway',
  'Touches per Order',
  'On-Time Delivery %',
  'Order Error Rate %',
  'Avg Order Cycle',
  'Supplier Defect Rate %',
  'New Bookings',
  'Pipeline Coverage Ratio',
  'Win Rate %',
  'Repeat Customer Rate %',
  'Average Order Value',
  'Net Promoter Score',
  'Customer Churn Rate %',
  'Quote Turnaround',
  'Reorder Rate %',
  'Employee eNPS',
  'Voluntary Turnover Rate %',
  'Revenue per Employee',
  'Training Hours per FTE'
];

function referencesRetiredKpi(text) {
  let value = String(text || '').toLocaleLowerCase();
  for (const kpi of SCORECARD_KPIS) {
    value = value.replaceAll(kpi.name.toLocaleLowerCase(), '');
  }
  return RETIRED_KPI_NAMES.some((name) =>
    value.includes(name.toLocaleLowerCase())
  );
}

// Default meeting start (local board-room clock) and block sizes.
const MEETING_START_MINUTES = 9 * 60; // 09:00
const MINUTES_KPI = 12;
const MINUTES_COMMENT = 8;
const MINUTES_QUESTION = 10;

export function buildAgendaSections() {
  return SCORECARD_LAYERS
    .slice()
    .sort((a, b) => a.position - b.position)
    .map((layer) => {
      const kpis = SCORECARD_KPIS
        .filter((kpi) => kpi.layer_position === layer.position)
        .slice()
        .sort((a, b) =>
          String(a.code).localeCompare(String(b.code), undefined, {
            numeric: true
          })
        )
        .map((kpi) => ({
          kind: 'kpi',
          code: kpi.code,
          key: kpi.key,
          name: kpi.name
        }));
      const watchItems = SCORECARD_WATCH_ITEMS
        .filter((item) => item.layer_position === layer.position)
        .map((item) => ({
          kind: 'watch_item',
          key: item.key,
          name: item.name,
          review: item.review
        }));

      return {
        position: layer.position,
        heading: `Layer ${layer.position} ${agendaLayerName(layer.position)}`,
        name: agendaLayerName(layer.position),
        type: layer.type,
        framing:
          layer.type === 'MANAGE'
            ? 'MANAGE — managed foundation; this is where the board spends its time.'
            : 'MONITOR — monitored output; review as a result of the managed foundation.',
        items: [...kpis, ...watchItems]
      };
    });
}

function topicId(prefix) {
  const rand = crypto.randomBytes
    ? crypto.randomBytes(4).toString('hex')
    : String(Date.now());
  return `${prefix}_${rand}`;
}

// Server-side RAG (mirrors apps/web/lib/rag.js). Only red/yellow feed the agenda.
export function computeStatus(value, kpi) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return 'none';
  }
  const v = Number(value);
  const { direction, green, yellow, red } = kpi;

  if (direction === 'down_good') {
    if (green !== null && green !== undefined && v <= green) return 'green';
    if (yellow !== null && yellow !== undefined && v <= yellow) return 'yellow';
    if (red !== null && red !== undefined && v <= red) return 'red';
    return red !== null || yellow !== null ? 'red' : 'yellow';
  }

  // up_good default
  if (green !== null && green !== undefined && v >= green) return 'green';
  if (yellow !== null && yellow !== undefined && v >= yellow) return 'yellow';
  if (red !== null && red !== undefined && v >= red) return 'red';
  return red !== null || yellow !== null ? 'red' : 'yellow';
}

export function latestValue(series) {
  if (!Array.isArray(series) || series.length === 0) return null;
  const last = series[series.length - 1];
  if (!last || last.value === null || last.value === undefined) return null;
  return Number(last.value);
}

function formatClock(totalMinutes) {
  const h = Math.floor(totalMinutes / 60) % 24;
  const m = totalMinutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function assignTimeBlocks(topics, startMinutes = MEETING_START_MINUTES) {
  let cursor = startMinutes;
  return topics.map((t) => {
    const duration = t.duration_minutes || 10;
    const start = formatClock(cursor);
    const end = formatClock(cursor + duration);
    cursor += duration;
    return {
      ...t,
      start_time: start,
      end_time: end,
      time_block: `${start}–${end}`,
      duration_minutes: duration
    };
  });
}

// Source rank within a layer (stable secondary key).
const SOURCE_RANK = { kpi: 0, comment: 1, analysis_question: 2 };

export function sortTopicsBottomUp(topics) {
  return [...topics].sort((a, b) => {
    const la = Number(a.layer) || 99;
    const lb = Number(b.layer) || 99;
    if (la !== lb) return la - lb;
    const sa = SOURCE_RANK[a.source] ?? 9;
    const sb = SOURCE_RANK[b.source] ?? 9;
    if (sa !== sb) return sa - sb;
    return String(a.title || '').localeCompare(String(b.title || ''));
  });
}

// Extract numbered questions under "## Questions the Board Should Ask".
export function extractBoardQuestions(markdown) {
  const text = String(markdown || '');
  const heading = SECTION_HEADINGS[4]; // Questions the Board Should Ask
  const re = new RegExp(
    `##\\s+${heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\n([\\s\\S]*?)(?=\\n##\\s+|$)`,
    'i'
  );
  const m = text.match(re);
  if (!m) return [];
  const body = m[1] || '';
  const lines = body.split(/\n/).map((l) => l.trim()).filter(Boolean);
  const questions = [];
  for (const line of lines) {
    // "1. question" or "- question" or plain sentence
    const cleaned = line
      .replace(/^\d+[\).\]]\s+/, '')
      .replace(/^[-*•]\s+/, '')
      .trim();
    if (cleaned.length < 8) continue;
    // Skip residual markdown noise
    if (/^#/.test(cleaned)) continue;
    questions.push(cleaned);
  }
  return questions;
}

// Build KPI topics for red/yellow only.
export function topicsFromKpis(valuesByKey) {
  const topics = [];
  for (const kpi of KPI_CATALOG) {
    const series = (valuesByKey && valuesByKey[kpi.key]) || [];
    const value = latestValue(series);
    const status = computeStatus(value, kpi);
    if (status !== 'red' && status !== 'yellow') continue;
    const agendaLayer = catalogLayerToAgenda(kpi.layer);
    topics.push({
      id: topicId('kpi'),
      source: 'kpi',
      title: `${status === 'red' ? 'Off track' : 'Watch'}: ${kpi.name}`,
      body: `Latest ${kpi.name} is ${value}${kpi.unit ? ` ${kpi.unit}` : ''} (${status}). Owner discussion required.`,
      layer: agendaLayer,
      layer_name: agendaLayerName(agendaLayer),
      kpi_key: kpi.key,
      kpi_name: kpi.name,
      status,
      value,
      duration_minutes: MINUTES_KPI
    });
  }
  return topics;
}

// Unresolved top-level comments only (replies stay inside the thread).
export function topicsFromComments(comments) {
  const topics = [];
  const list = Array.isArray(comments) ? comments : [];
  for (const c of list) {
    if (!c || c.resolved) continue;
    // Only root comments become agenda topics; replies are discussion.
    if (c.parent_id) continue;
    if (referencesRetiredKpi(c.body)) continue;
    let agendaLayer = 1;
    let kpiKey = null;
    if (c.kpi_id) {
      kpiKey = c.kpi_id;
      const kpi = KPI_BY_KEY.get(c.kpi_id);
      // Comments left against retired KPI records must not leak those deleted
      // KPI references back into a newly generated agenda.
      if (!kpi) continue;
      agendaLayer = catalogLayerToAgenda(kpi.layer);
    } else if (c.analysis_id) {
      // Analysis discussion sits with Leadership Alignment (opens the meeting).
      agendaLayer = 1;
    } else if (c.memo_id) {
      agendaLayer = 1;
    }
    const snippet = String(c.body || '').slice(0, 160);
    topics.push({
      id: topicId('cmt'),
      source: 'comment',
      title: `Open comment${kpiKey ? ` on ${kpiKey}` : ''}`,
      body: snippet,
      layer: agendaLayer,
      layer_name: agendaLayerName(agendaLayer),
      comment_id: c.id,
      kpi_key: kpiKey,
      duration_minutes: MINUTES_COMMENT
    });
  }
  return topics;
}

export function topicsFromQuestions(questions) {
  // Board questions open under Leadership Alignment so the meeting frames
  // governance first; later layers still host KPI/comment topics after.
  return (questions || [])
    .filter((q) => !referencesRetiredKpi(q))
    .map((q, i) => ({
    id: topicId('q'),
    source: 'analysis_question',
    title: `Board question ${i + 1}`,
    body: q,
    layer: 1,
    layer_name: agendaLayerName(1),
    question_index: i + 1,
    duration_minutes: MINUTES_QUESTION
    }));
}

// Full generation pipeline. Returns generated_content object.
export async function generateAgendaContent({
  valuesByKey,
  comments,
  memos,
  env
} = {}) {
  const kpiTopics = topicsFromKpis(valuesByKey || {});
  const commentTopics = topicsFromComments(comments || []);

  // Latest analysis questions — use offline/online independent analysis.
  let analysisMarkdown = '';
  let analysisSource = 'none';
  try {
    const result = await generateIndependentAnalysis({
      valuesByKey: valuesByKey || {},
      memos: memos || [],
      env: env || process.env
    });
    analysisMarkdown = (result && result.markdown) || '';
    analysisSource = (result && result.source) || 'unknown';
  } catch {
    analysisMarkdown = '';
    analysisSource = 'error';
  }
  const questions = extractBoardQuestions(analysisMarkdown);
  const questionTopics = topicsFromQuestions(questions);

  const ordered = sortTopicsBottomUp([
    ...kpiTopics,
    ...commentTopics,
    ...questionTopics
  ]);
  const timed = assignTimeBlocks(ordered);

  return {
    framing:
      'MANAGE Layers 1–3 as the foundation where the board spends its time; MONITOR Layers 4–5 as outputs.',
    sections: buildAgendaSections(),
    topics: timed,
    layers: AGENDA_LAYERS.map((l) => ({
      position: l.position,
      name: l.name
    })),
    meeting_start: formatClock(MEETING_START_MINUTES),
    total_minutes: timed.reduce((n, t) => n + (t.duration_minutes || 0), 0),
    sources: {
      red_yellow_kpis: kpiTopics.length,
      unresolved_comments: commentTopics.length,
      analysis_questions: questionTopics.length,
      analysis_source: analysisSource
    }
  };
}
