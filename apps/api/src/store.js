// Boardroom Phase 1 store — server-side authority for founder KPI entry,
// definition/threshold editing, and the append-only audit trail.
//
// Why this exists (and why it is in-memory): the live deployment runs with NO
// external Supabase project bound (isAdminConfigured() === false — see
// server.js / seedData.js), so the canonical `kpi_values` / `kpis` / `audit_log`
// tables are unreachable. Rather than dead-end the mission's founder workflow,
// this module is the faithful in-process realization of those tables for an
// un-provisioned deploy: a founder (JWT app_metadata.role === 'founder') can
// write a value or edit a definition, every such change appends an immutable
// audit row (who/when/old/new), and the board can only read. The moment a real
// admin project is bound, GET /api/kpi-values still reads the live table as its
// base; store overrides simply layer on top.
//
// State lives in module scope so it is shared across every request in the one
// Railway process (which is all the live tester needs within a deploy's
// lifetime) and starts fresh on each boot — deterministic, no disk, no secret
// ever stored. Tests reset it with resetStore().
import { SEED_KPI_VALUES } from './seedData.js';

// ISO date far enough in the past that its definition-change is ALWAYS older
// than 90 days — seeds the "no flag after 90 days" acceptance case (criterion 9)
// with a stable, deploy-independent target the board/founder can observe.
const STALE_DEFINITION_CHANGE = '2020-01-01T00:00:00.000Z';

// A single KPI carries a long-ago definition edit so its card never shows the
// "definition changed" flag — the durable fixture for the 90-day expiry check.
function seedDefinitions() {
  return {
    gross_margin_pct: {
      definition:
        'Gross profit as a percentage of revenue (revenue minus COGS, over revenue).',
      definition_changed_at: STALE_DEFINITION_CHANGE
    }
  };
}

let state = freshState();

function freshState() {
  return {
    // values[key][period] = { value, note, recorded_by, recorded_at }
    values: {},
    // definitions[key] = { definition, green_threshold, ..., definition_changed_at }
    definitions: seedDefinitions(),
    // append-only; newest last
    audit: []
  };
}

// Reset to a fresh seeded state — for tests only (each test starts clean).
export function resetStore() {
  state = freshState();
}

// Monotonic-ish id without Math.random (kept deterministic-friendly): audit
// rows are ordered by insertion, so a counter + timestamp suffices.
let auditSeq = 0;
function nextAuditId() {
  auditSeq += 1;
  return `audit_${auditSeq}`;
}

// Normalize a founder-entered period to the stored ISO date form. The founder
// form submits YYYY-MM (a month); the seed + client sparkline use YYYY-MM-01,
// so a bare month is anchored to the first of the month. An already-ISO date
// passes through. Returns '' for anything unparseable so callers can 400.
export function normalizePeriod(period) {
  const p = String(period == null ? '' : period).trim();
  if (/^\d{4}-\d{2}$/.test(p)) return `${p}-01`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(p)) return p;
  return '';
}

// Overlay founder-written value overrides on top of a base value map (the
// Supabase read, or the committed SEED). Base and result share the wire shape
// GET /api/kpi-values returns: { <key>: [{ period, value }, ...] } ascending.
// Pure w.r.t. the passed base; reads current store state.
export function overlayValues(baseByKey) {
  const out = {};
  const base = baseByKey && typeof baseByKey === 'object' ? baseByKey : {};
  for (const [key, arr] of Object.entries(base)) {
    if (Array.isArray(arr)) out[key] = arr.map((p) => ({ ...p }));
  }
  for (const [key, byPeriod] of Object.entries(state.values)) {
    const map = new Map((out[key] || []).map((p) => [String(p.period), { ...p }]));
    for (const [period, rec] of Object.entries(byPeriod)) {
      map.set(period, { period, value: rec.value, note: rec.note });
    }
    out[key] = [...map.values()].sort((a, b) =>
      String(a.period).localeCompare(String(b.period))
    );
  }
  return out;
}

// Convenience: the merged view with the committed SEED as the base (the
// un-provisioned live path).
export function seededValues() {
  return overlayValues(SEED_KPI_VALUES);
}

// The current stored value for key+period, drawn from the same merged view a
// reader sees — so a value change's audited "old" matches what was on screen.
function currentValue(key, period) {
  const merged = seededValues();
  const series = merged[key] || [];
  const hit = series.find((p) => String(p.period) === period);
  return hit ? hit.value : null;
}

// Founder value entry (idempotent upsert by key+period). Records the value and
// appends an audit row capturing who/when/old/new. `actor` is { id, email,
// role }. Returns the stored record.
export function upsertValue({ key, period, value, note, actor }) {
  const normPeriod = normalizePeriod(period);
  const old = currentValue(key, normPeriod);
  const recorded_at = new Date().toISOString();
  (state.values[key] ||= {})[normPeriod] = {
    value,
    note: note || null,
    recorded_by: (actor && actor.email) || null,
    recorded_at
  };
  appendAudit({
    actor,
    action: 'kpi_value.upsert',
    entity: 'kpi_values',
    target: `${key} · ${normPeriod}`,
    field: 'value',
    old_value: old,
    new_value: value,
    created_at: recorded_at
  });
  return { key, period: normPeriod, value, note: note || null, recorded_at };
}

// Fields a founder may edit on a KPI definition. `definition` is the prose; the
// rest are the RAG thresholds/band.
const DEFINITION_FIELDS = [
  'definition',
  'direction',
  'unit',
  'green_threshold',
  'yellow_threshold',
  'red_threshold',
  'target_min',
  'target_max'
];

// Founder definition/threshold edit. Records the new definition, stamps
// definition_changed_at = now (drives the 90-day "definition changed" card
// flag), and appends one audit row per changed field (who/when/old/new).
// Returns the stored definition record.
export function updateDefinition({ key, patch, actor }) {
  const prev = state.definitions[key] || {};
  const now = new Date().toISOString();
  const next = { ...prev };
  const changes = [];
  for (const field of DEFINITION_FIELDS) {
    if (patch[field] === undefined) continue;
    const oldVal = prev[field] === undefined ? null : prev[field];
    const newVal = patch[field];
    next[field] = newVal;
    if (oldVal !== newVal) changes.push({ field, old: oldVal, new: newVal });
  }
  next.definition_changed_at = now;
  state.definitions[key] = next;

  // Always audit the edit even if the text is unchanged (a re-affirmation still
  // resets the 90-day window); emit one row per changed field, plus a definition
  // marker row so the audit view always shows the who/when of the edit.
  if (changes.length === 0) {
    appendAudit({
      actor,
      action: 'kpi_definition.update',
      entity: 'kpis',
      target: `${key} · definition`,
      field: 'definition_changed_at',
      old_value: prev.definition_changed_at || null,
      new_value: now,
      created_at: now
    });
  } else {
    for (const c of changes) {
      appendAudit({
        actor,
        action: 'kpi_definition.update',
        entity: 'kpis',
        target: `${key} · ${c.field}`,
        field: c.field,
        old_value: c.old,
        new_value: c.new,
        created_at: now
      });
    }
  }
  return { key, ...next };
}

// The definitions map readers see: { <key>: { definition?, ..., changed,
// definition_changed_at } }. `changed` is the derived boolean — true only when
// the last edit is within the 90-day window (criterion 8/9) — so the client
// renders the flag without re-deriving the cutoff. Both roles may read.
const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;
export function listDefinitions(nowMs = Date.now()) {
  const out = {};
  for (const [key, def] of Object.entries(state.definitions)) {
    const at = def.definition_changed_at
      ? Date.parse(def.definition_changed_at)
      : NaN;
    const changed = Number.isFinite(at) && nowMs - at < NINETY_DAYS_MS;
    out[key] = { ...def, changed };
  }
  return out;
}

// Append-only audit push. Immutable by contract — nothing mutates or deletes
// rows once written (mirrors the audit_log RLS: INSERT + SELECT only).
function appendAudit(row) {
  state.audit.push({
    id: nextAuditId(),
    actor_id: (row.actor && row.actor.id) || null,
    actor_email: (row.actor && row.actor.email) || null,
    actor_role: (row.actor && row.actor.role) || null,
    action: row.action,
    entity: row.entity,
    target: row.target,
    field: row.field,
    old_value: row.old_value === undefined ? null : row.old_value,
    new_value: row.new_value === undefined ? null : row.new_value,
    created_at: row.created_at || new Date().toISOString()
  });
}

// The audit trail, newest first (the order the founder audit view reads top to
// bottom). Returns a copy so callers can't mutate the log.
export function listAudit() {
  return state.audit.slice().reverse();
}
