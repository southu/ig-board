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

// KPI catalog (mirrors apps/web/lib/catalog.js) — server copy so the generator
// never imports the Next app. Keys + layer + thresholds + direction only.
export const KPI_CATALOG = [
  { key: 'revenue_plan_fy1', name: 'Revenue Plan FY1', layer: 1, direction: 'up_good', unit: 'USD', green: 29000000, yellow: null, red: null },
  { key: 'revenue_plan_fy2', name: 'Revenue Plan FY2', layer: 1, direction: 'up_good', unit: 'USD', green: 33000000, yellow: null, red: null },
  { key: 'revenue_plan_fy3', name: 'Revenue Plan FY3', layer: 1, direction: 'up_good', unit: 'USD', green: 35000000, yellow: null, red: null },
  { key: 'gross_margin_pct', name: 'Gross Margin %', layer: 1, direction: 'up_good', unit: '%', green: 38, yellow: 34, red: 30 },
  { key: 'ebitda_margin_pct', name: 'EBITDA Margin %', layer: 1, direction: 'up_good', unit: '%', green: 12, yellow: 8, red: 5 },
  { key: 'cash_runway_months', name: 'Cash Runway (months)', layer: 1, direction: 'up_good', unit: 'months', green: 9, yellow: 6, red: 3 },
  { key: 'bypass_count', name: 'Bypass Count', layer: 2, direction: 'down_good', unit: 'count', green: 0, yellow: 2, red: 3 },
  { key: 'touches_per_order', name: 'Touches per Order', layer: 2, direction: 'down_good', unit: 'touches', green: 6, yellow: null, red: null },
  { key: 'on_time_delivery_pct', name: 'On-Time Delivery %', layer: 2, direction: 'up_good', unit: '%', green: 97, yellow: 93, red: 90 },
  { key: 'order_error_rate', name: 'Order Error Rate %', layer: 2, direction: 'down_good', unit: '%', green: 1, yellow: 3, red: 5 },
  { key: 'avg_order_cycle_days', name: 'Avg Order Cycle (days)', layer: 2, direction: 'down_good', unit: 'days', green: 5, yellow: 8, red: 12 },
  { key: 'supplier_defect_rate', name: 'Supplier Defect Rate %', layer: 2, direction: 'down_good', unit: '%', green: 1, yellow: 2, red: 4 },
  { key: 'new_bookings', name: 'New Bookings', layer: 3, direction: 'up_good', unit: 'USD', green: 2500000, yellow: 1800000, red: 1200000 },
  { key: 'pipeline_coverage_ratio', name: 'Pipeline Coverage Ratio', layer: 3, direction: 'up_good', unit: 'x', green: 3, yellow: 2, red: 1.5 },
  { key: 'win_rate_pct', name: 'Win Rate %', layer: 3, direction: 'up_good', unit: '%', green: 30, yellow: 22, red: 15 },
  { key: 'repeat_customer_rate', name: 'Repeat Customer Rate %', layer: 3, direction: 'up_good', unit: '%', green: 60, yellow: 45, red: 35 },
  { key: 'avg_order_value', name: 'Average Order Value', layer: 3, direction: 'up_good', unit: 'USD', green: 4000, yellow: 3000, red: 2000 },
  { key: 'nps', name: 'Net Promoter Score', layer: 4, direction: 'up_good', unit: 'score', green: 50, yellow: 30, red: 10 },
  { key: 'customer_churn_rate', name: 'Customer Churn Rate %', layer: 4, direction: 'down_good', unit: '%', green: 5, yellow: 10, red: 15 },
  { key: 'quote_turnaround_hours', name: 'Quote Turnaround (hours)', layer: 4, direction: 'down_good', unit: 'hours', green: 24, yellow: 48, red: 72 },
  { key: 'reorder_rate', name: 'Reorder Rate %', layer: 4, direction: 'up_good', unit: '%', green: 40, yellow: 30, red: 20 },
  { key: 'employee_enps', name: 'Employee eNPS', layer: 5, direction: 'up_good', unit: 'score', green: 30, yellow: 10, red: 0 },
  { key: 'voluntary_turnover_rate', name: 'Voluntary Turnover Rate %', layer: 5, direction: 'down_good', unit: '%', green: 8, yellow: 14, red: 20 },
  { key: 'revenue_per_employee', name: 'Revenue per Employee', layer: 5, direction: 'up_good', unit: 'USD', green: 300000, yellow: 250000, red: 200000 },
  { key: 'training_hours_per_fte', name: 'Training Hours per FTE', layer: 5, direction: 'up_good', unit: 'hours', green: 40, yellow: 20, red: 10 }
];

const KPI_BY_KEY = new Map(KPI_CATALOG.map((k) => [k.key, k]));

// Default meeting start (local board-room clock) and block sizes.
const MEETING_START_MINUTES = 9 * 60; // 09:00
const MINUTES_KPI = 12;
const MINUTES_COMMENT = 8;
const MINUTES_QUESTION = 10;

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
    let agendaLayer = 1;
    let kpiKey = null;
    if (c.kpi_id) {
      kpiKey = c.kpi_id;
      const kpi = KPI_BY_KEY.get(c.kpi_id);
      if (kpi) agendaLayer = catalogLayerToAgenda(kpi.layer);
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
  return (questions || []).map((q, i) => ({
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
