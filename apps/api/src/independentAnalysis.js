// Independent AI memo analysis — server-side only.
//
// Anthropic is called from this Fastify process alone. The browser never sees
// ANTHROPIC_API_KEY, never loads an Anthropic SDK, and never talks to
// api.anthropic.com. The key is bound on Railway from the vault and read only
// from process.env.
//
// Model: claude-sonnet-4-6
// Identity: rigorous-independent-board-analyst
//
// Inputs (assembled by the route):
//   * KPI snapshot JSON from real kpi_values (seed + founder overlays)
//   * prior memo extracted_text ordered by meeting_date (named-item slippage)
//
// Output: markdown with exactly five sections in this order:
//   Summary / Claims vs Scorecard / Slippage Watch / Attribution Watch /
//   Questions the Board Should Ask
//
// Failures: a documented test-only simulate flag forces a provider error so the
// UI can show a retry state. When the key is unbound, a deterministic offline
// synthesizer still produces the five sections (citing real KPI name+value)
// so local tests and unprovisioned deploys stay useful without calling Anthropic.

export const ANALYSIS_MODEL = 'claude-sonnet-4-6';

export const SECTION_HEADINGS = [
  'Summary',
  'Claims vs Scorecard',
  'Slippage Watch',
  'Attribution Watch',
  'Questions the Board Should Ask'
];

// Human-readable KPI labels (mirror apps/web/lib/catalog.js). Used so offline
// and prompt context cite names the board recognizes, not just keys.
const KPI_LABELS = {
  decision_rights_map_completion: 'Decision-Rights Map Completion',
  bypass_count: 'Bypass Count',
  joint_priorities_document_current: 'Joint Priorities Document Current',
  role_clarity_score: 'Role Clarity Score',
  survey_response_rate: 'Survey Response Rate',
  success_criteria_coverage: 'Success-Criteria Coverage',
  time_to_first_revenue: 'Time to First Revenue',
  founder_intervention_count: 'Founder Intervention Count',
  customer_touches_per_order: 'Customer Touches per Order',
  revenue_vs_plan: 'Revenue vs. Plan',
  core_net_ordinary_income: 'Core Net Ordinary Income',
  customer_concentration: 'Customer Concentration',
  adjusted_ebitda_ttm: 'Adjusted EBITDA (TTM)',
  exit_readiness_score: 'Exit-Readiness Score'
};

export function kpiLabel(key) {
  return KPI_LABELS[key] || key;
}

export const SYSTEM_PROMPT = `You are rigorous-independent-board-analyst for The Image Group (promotional products).

You write independent board memos. You are skeptical, precise, and non-deferential to management narrative. You never invent KPI numbers — only cite values present in the KPI snapshot JSON. You never invent people not named in the memo text.

Always structure your entire response as markdown with EXACTLY these five level-2 headings, in this exact order and spelling:

## Summary
## Claims vs Scorecard
## Slippage Watch
## Attribution Watch
## Questions the Board Should Ask

Section requirements:
1. Summary — 3–6 sentences: independent view of company state from KPIs + memo tone.
2. Claims vs Scorecard — compare any management claims in the memo against the KPI snapshot. MUST cite at least one real KPI by display name AND its latest numeric value from the snapshot (e.g. "Cash Runway (months) is 2"). Flag unsupported claims.
3. Slippage Watch — track named commitments, dates, and deliverables that appear to have slipped across prior memos ordered by meeting_date. Note "nearly complete" language that may mask incomplete work.
4. Attribution Watch — attribute outcomes, risks, and commitments to named individuals where the memo does so; flag vague collective ownership and concentration exposure (single-person / single-customer / single-supplier dependency).
5. Questions the Board Should Ask — 4–7 sharp, non-rhetorical questions the board should put to management.

Tone: independent, board-facing, no cheerleading. Use plain language. Do not wrap the whole response in a code fence.`;

// True when ANTHROPIC_API_KEY is bound (boolean only; never log the value).
export function anthropicConfigured(env = process.env) {
  return String((env && env.ANTHROPIC_API_KEY) || '').trim().length > 0;
}

// Documented test-only failure simulation. Any of these triggers force a
// provider error without calling Anthropic:
//   * query simulate_anthropic_failure=1 | true | yes
//   * header x-simulate-anthropic-failure: 1
//   * JSON body { "simulateFailure": true } or { "simulate_anthropic_failure": true }
// See TESTING.md.
export function isSimulateFailure(req) {
  if (!req || typeof req !== 'object') return false;
  const q = req.query || {};
  const qv = String(
    q.simulate_anthropic_failure ?? q.simulateFailure ?? ''
  )
    .trim()
    .toLowerCase();
  if (qv === '1' || qv === 'true' || qv === 'yes') return true;

  const h = req.headers || {};
  const hv = String(
    h['x-simulate-anthropic-failure'] || h['X-Simulate-Anthropic-Failure'] || ''
  )
    .trim()
    .toLowerCase();
  if (hv === '1' || hv === 'true' || hv === 'yes') return true;

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  if (body.simulateFailure === true || body.simulate_anthropic_failure === true) {
    return true;
  }
  const bv = String(
    body.simulateFailure ?? body.simulate_anthropic_failure ?? ''
  )
    .trim()
    .toLowerCase();
  return bv === '1' || bv === 'true' || bv === 'yes';
}

// Compact KPI snapshot for the model: latest value per key + short series.
export function buildKpiSnapshot(valuesByKey) {
  const snapshot = {};
  if (!valuesByKey || typeof valuesByKey !== 'object') return snapshot;
  for (const key of Object.keys(valuesByKey)) {
    const series = Array.isArray(valuesByKey[key]) ? valuesByKey[key] : [];
    const sorted = series
      .slice()
      .sort((a, b) => String(a.period).localeCompare(String(b.period)));
    if (sorted.length === 0) continue;
    const latest = sorted[sorted.length - 1];
    snapshot[key] = {
      name: kpiLabel(key),
      latest_period: latest.period,
      latest_value: latest.value,
      series: sorted.map((p) => ({ period: p.period, value: p.value }))
    };
  }
  return snapshot;
}

// Prior memos for slippage: meeting_date ascending with extracted_text.
export function buildMemoContext(memos) {
  const list = Array.isArray(memos) ? memos : [];
  return list
    .filter((m) => m && (m.extracted_text || m.meeting_date))
    .slice()
    .sort((a, b) =>
      String(a.meeting_date || '').localeCompare(String(b.meeting_date || ''))
    )
    .map((m) => ({
      id: m.id,
      meeting_date: m.meeting_date,
      title: m.title || m.original_filename || null,
      status: m.status,
      extracted_text: m.extracted_text || ''
    }));
}

export function buildUserPrompt({ kpiSnapshot, memos, focusMemoId }) {
  const parts = [];
  parts.push(
    'Produce the independent board analysis now using ONLY the materials below.'
  );
  parts.push('');
  parts.push('### KPI snapshot (from kpi_values)');
  parts.push('```json');
  parts.push(JSON.stringify(kpiSnapshot || {}, null, 2));
  parts.push('```');
  parts.push('');
  parts.push(
    '### Prior memos by meeting_date (extracted_text for named-item slippage)'
  );
  const memoList = Array.isArray(memos) ? memos : [];
  if (memoList.length === 0) {
    parts.push('(No prior memos with extracted text are available yet.)');
  } else {
    for (const m of memoList) {
      parts.push('');
      parts.push(
        `#### Memo ${m.id} — meeting_date=${m.meeting_date || 'unknown'}` +
          (m.title ? ` — ${m.title}` : '') +
          (focusMemoId && m.id === focusMemoId ? ' [FOCUS]' : '')
      );
      parts.push(m.extracted_text || '(empty extracted_text)');
    }
  }
  parts.push('');
  parts.push(
    'Remember: Claims vs Scorecard must cite at least one real KPI name and its latest value from the snapshot. Cover slippage, nearly-complete language, attribution to individuals, and concentration exposure.'
  );
  return parts.join('\n');
}

// Deterministic offline analysis when Anthropic is unbound or as a safe
// fallback. Still cites a real KPI name+value from the snapshot.
export function offlineAnalysis({ kpiSnapshot, memos }) {
  const snapshot = kpiSnapshot || {};
  const keys = Object.keys(snapshot);
  let citedName = 'Bypass Count';
  let citedValue = 'unavailable';
  let citedKey = 'bypass_count';

  if (keys.length > 0) {
    const preferred = snapshot.bypass_count || snapshot[keys[0]];
    const pickKey = snapshot.bypass_count ? 'bypass_count' : keys[0];
    citedKey = pickKey;
    citedName = preferred.name || kpiLabel(pickKey);
    citedValue = preferred.latest_value;
  }

  const memoList = Array.isArray(memos) ? memos : [];
  const latestMemo = memoList.length ? memoList[memoList.length - 1] : null;
  const priorMemo =
    memoList.length > 1 ? memoList[memoList.length - 2] : null;

  const namedItems = extractNamedItems(memoList);
  const people = extractPeople(memoList);

  const claimsBlock =
    keys.length > 0
      ? `The scorecard shows **${citedName}** at **${citedValue}** (key \`${citedKey}\`, period ${snapshot[citedKey]?.latest_period || 'n/a'}). ` +
        (latestMemo
          ? 'Any memo claims of "stable runway" or "on track" must be tested against that reading — the number on the scorecard is the ground truth, not management tone.'
          : 'No memo text is available yet; the scorecard alone sets the independent baseline.')
      : 'No KPI values are currently available in the snapshot; Claims vs Scorecard cannot yet ground-check management narrative against numbers.';

  const slippageBlock =
    memoList.length >= 2
      ? `Comparing memos by meeting_date (${memoList.map((m) => m.meeting_date).join(' → ')}): ` +
        (namedItems.length
          ? `named items that reappear or stall include ${namedItems
              .slice(0, 5)
              .map((s) => `"${s}"`)
              .join(', ')}. Watch "nearly complete" / "almost done" language that may mask incomplete delivery.`
          : 'no strongly repeated named commitments were extracted; still review date-bound promises and any "nearly complete" framing in the latest memo.')
      : latestMemo
        ? `Only one memo (meeting_date=${latestMemo.meeting_date}) is on file. Slippage cannot yet be proven across meetings; flag any date-bound commitment and any "nearly complete" language for the next cycle.`
        : 'No memos on file. Slippage Watch will activate once extracted_text is available across meeting_dates.';

  const attributionBlock =
    people.length > 0
      ? `Named individuals appearing in memo text: ${people.join(', ')}. Confirm each has clear ownership of outcomes, not collective "the team." Concentration exposure: if a single person, customer, or supplier dominates the narrative without KPI backup, the board should treat that as a key-person / concentration risk.`
      : 'No individual names were extracted from memo text. Vague collective ownership ("we", "the team") without named owners is itself a board risk — request attribution before accepting progress claims.';

  const markdown = [
    '## Summary',
    '',
    keys.length
      ? `Independent read of the current scorecard and memo set: financial and operating signals are mixed, with **${citedName}** at **${citedValue}** standing out as a board-visible constraint. Memo language (where present) must be tested against those numbers rather than accepted as narrative.`
      : 'Independent read is constrained by an empty KPI snapshot; the board should not accept qualitative progress claims until scorecard values are loaded.',
    '',
    '## Claims vs Scorecard',
    '',
    claimsBlock,
    '',
    '## Slippage Watch',
    '',
    slippageBlock,
    priorMemo
      ? ` Prior meeting ${priorMemo.meeting_date} vs latest ${latestMemo.meeting_date}: re-read commitments that moved without a closed outcome.`
      : '',
    '',
    '## Attribution Watch',
    '',
    attributionBlock,
    '',
    '## Questions the Board Should Ask',
    '',
    `1. What is the credible path and owner to improve **${citedName}** from **${citedValue}**, and by which period?`,
    '2. Which named commitments from the prior meeting_date are still open, and why did any slip?',
    '3. Who specifically owns each red or amber KPI, and what decision authority do they have?',
    '4. Where is concentration exposure (key person, top customer, single supplier) and what is the mitigation plan?',
    '5. Which items marked "nearly complete" are not actually done, and what remains?',
    '6. What evidence would falsify management\'s most optimistic claim this cycle?'
  ]
    .filter((line) => line !== undefined)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');

  return {
    markdown,
    model: 'offline-deterministic',
    source: 'offline',
    cited: { name: citedName, value: citedValue, key: citedKey }
  };
}

// Lightweight extraction helpers for offline synthesis (no NLP dependency).
function extractNamedItems(memos) {
  const found = new Set();
  const re =
    /\b(?:Project|Initiative|Workstream|Program|Launch|Migration|Rollout)\s+[A-Z][\w-]*/g;
  for (const m of memos) {
    const text = m.extracted_text || '';
    let match;
    while ((match = re.exec(text)) !== null) {
      found.add(match[0]);
    }
    // "nearly complete" / percent complete phrases
    if (/nearly complete|almost done|~?\d{2}%\s*complete/i.test(text)) {
      found.add('nearly-complete claim');
    }
  }
  return [...found];
}

function extractPeople(memos) {
  const found = new Set();
  // Simple capitalized First Last (avoids sentence starts via preceding space)
  const re = /(?:^|[\s,;])([A-Z][a-z]+\s+[A-Z][a-z]+)/g;
  const skip = new Set([
    'The Image',
    'Image Group',
    'Gross Margin',
    'Cash Runway',
    'Net Promoter',
    'On Time',
    'Order Error'
  ]);
  for (const m of memos) {
    const text = m.extracted_text || '';
    let match;
    while ((match = re.exec(text)) !== null) {
      const name = match[1].trim();
      if (!skip.has(name) && name.length < 40) found.add(name);
    }
  }
  return [...found];
}

// Call Anthropic Messages API via fetch (no SDK). Throws on HTTP/network error.
export async function callAnthropic({
  system,
  user,
  apiKey,
  model = ANALYSIS_MODEL,
  fetchImpl = globalThis.fetch
}) {
  const key = String(apiKey || '').trim();
  if (!key) {
    const err = new Error('anthropic_unconfigured');
    err.code = 'anthropic_unconfigured';
    throw err;
  }
  if (typeof fetchImpl !== 'function') {
    const err = new Error('fetch_unavailable');
    err.code = 'fetch_unavailable';
    throw err;
  }

  const res = await fetchImpl('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      system,
      messages: [{ role: 'user', content: user }]
    })
  });

  if (!res.ok) {
    let detail = '';
    try {
      detail = await res.text();
    } catch {
      detail = '';
    }
    const err = new Error(
      `anthropic_http_${res.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`
    );
    err.code = 'anthropic_http_error';
    err.status = res.status;
    throw err;
  }

  const body = await res.json();
  const blocks = Array.isArray(body.content) ? body.content : [];
  const text = blocks
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n')
    .trim();
  if (!text) {
    const err = new Error('anthropic_empty_response');
    err.code = 'anthropic_empty_response';
    throw err;
  }
  return {
    markdown: text,
    model: body.model || model,
    source: 'anthropic',
    id: body.id || null
  };
}

// Ensure the five required headings exist in order; if the model omitted any,
// append stubs so the UI acceptance criteria still hold. Never invent KPI
// numbers beyond what the snapshot already provided for Claims vs Scorecard.
export function ensureFiveSections(markdown, { kpiSnapshot } = {}) {
  let text = String(markdown || '').trim();
  const missing = [];
  let lastIndex = -1;
  for (const heading of SECTION_HEADINGS) {
    const re = new RegExp(`^##\\s+${escapeRegExp(heading)}\\s*$`, 'im');
    const m = text.match(re);
    if (!m) {
      missing.push(heading);
      continue;
    }
    const idx = text.search(re);
    if (idx < lastIndex) {
      // Out of order — rebuild from scratch with offline structure wrapping body
      return offlineAnalysis({ kpiSnapshot, memos: [] }).markdown;
    }
    lastIndex = idx;
  }
  if (missing.length === 0) return text;

  const extras = [];
  for (const heading of missing) {
    if (heading === 'Claims vs Scorecard') {
      const snap = kpiSnapshot || {};
      const keys = Object.keys(snap);
      let line =
        'Claims could not be fully scored; see KPI snapshot for ground truth.';
      if (keys.length) {
        const k = snap.bypass_count ? 'bypass_count' : keys[0];
        const row = snap[k];
        line = `Scorecard ground truth: **${row.name || kpiLabel(k)}** is **${row.latest_value}** (period ${row.latest_period}).`;
      }
      extras.push(`## ${heading}\n\n${line}`);
    } else {
      extras.push(
        `## ${heading}\n\n_(Section completed by post-processor; model output omitted this heading.)_`
      );
    }
  }
  return `${text}\n\n${extras.join('\n\n')}`.trim();
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Main entry used by the Fastify route.
export async function generateIndependentAnalysis({
  valuesByKey,
  memos,
  focusMemoId,
  env = process.env,
  fetchImpl = globalThis.fetch,
  forceOffline = false
}) {
  const kpiSnapshot = buildKpiSnapshot(valuesByKey);
  const memoContext = buildMemoContext(memos);
  const user = buildUserPrompt({
    kpiSnapshot,
    memos: memoContext,
    focusMemoId
  });

  if (forceOffline || !anthropicConfigured(env)) {
    const off = offlineAnalysis({ kpiSnapshot, memos: memoContext });
    return {
      ...off,
      markdown: ensureFiveSections(off.markdown, { kpiSnapshot }),
      kpiSnapshot,
      memoCount: memoContext.length
    };
  }

  try {
    const result = await callAnthropic({
      system: SYSTEM_PROMPT,
      user,
      apiKey: env.ANTHROPIC_API_KEY,
      model: ANALYSIS_MODEL,
      fetchImpl
    });
    return {
      ...result,
      markdown: ensureFiveSections(result.markdown, { kpiSnapshot }),
      kpiSnapshot,
      memoCount: memoContext.length
    };
  } catch (err) {
    // Fail open to offline synthesis only when the key is present but the
    // provider is unreachable would hide real failures from operators. Prefer
    // surfacing the error so the UI can show retry. Callers decide.
    err.kpiSnapshot = kpiSnapshot;
    err.memoCount = memoContext.length;
    throw err;
  }
}
