// In-process last_seen_at + change digest for the Phase 4 /whats-new surface.
//
// Mirrors public.users.last_seen_at when no external Supabase project is bound
// (the same pattern as store.js / commentsStore.js). Keyed by JWT sub so each
// member has an independent cursor. Tests reset with resetWhatsNewStore().
//
// Digest items are drawn from:
//   1. Founder audit trail (kpi_value.upsert / kpi_definition.update)
//   2. Committed seed kpi_values (stable demo history the board can notice)
//
// GET /api/whats-new lists only items with created_at strictly AFTER the caller's
// last_seen_at (null last_seen → all items), then advances last_seen_at to now
// so a revisit is empty or reduced.

import { listAudit } from './store.js';
import { SEED_KPI_VALUES } from './seedData.js';

/** @type {Map<string, string>} userId -> ISO last_seen_at */
let lastSeenByUser = new Map();

export function resetWhatsNewStore() {
  lastSeenByUser = new Map();
}

export function getLastSeen(userId) {
  if (!userId) return null;
  return lastSeenByUser.get(String(userId)) || null;
}

export function setLastSeen(userId, iso) {
  if (!userId) return;
  lastSeenByUser.set(String(userId), iso);
}

// Flatten seed series into digest-friendly change rows (non-secret demo data).
function seedChangeItems() {
  const items = [];
  for (const [key, series] of Object.entries(SEED_KPI_VALUES || {})) {
    if (!Array.isArray(series)) continue;
    for (const point of series) {
      const period = String(point.period || '');
      // Anchor seed observations at noon UTC on the period date so they sort
      // cleanly and sit before "now" after the first mark-as-seen.
      const created_at = period
        ? `${period.slice(0, 10)}T12:00:00.000Z`
        : '2026-01-01T12:00:00.000Z';
      items.push({
        id: `seed:${key}:${period}`,
        kind: 'kpi_value',
        source: 'seed',
        kpi_key: key,
        period,
        value: point.value,
        summary: `KPI ${key} recorded ${point.value} for ${period}`,
        created_at
      });
    }
  }
  return items;
}

function auditChangeItems() {
  const entries = listAudit();
  return entries.map((e) => ({
    id: e.id,
    kind: e.action === 'kpi_definition.update' ? 'kpi_definition' : 'kpi_value',
    source: 'audit',
    kpi_key: null,
    period: null,
    value: e.new_value,
    summary: `${e.action}: ${e.target || e.entity || 'change'} (${e.field || 'value'} ${
      e.old_value == null ? '∅' : e.old_value
    } → ${e.new_value == null ? '∅' : e.new_value})`,
    actor_email: e.actor_email || null,
    created_at: e.created_at
  }));
}

// All known changes, newest first.
export function listAllChanges() {
  const all = [...seedChangeItems(), ...auditChangeItems()];
  all.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  return all;
}

// Changes strictly after `sinceIso` (null/empty → everything). Newest first.
export function listChangesSince(sinceIso) {
  const all = listAllChanges();
  if (!sinceIso) return all;
  const sinceMs = Date.parse(sinceIso);
  if (!Number.isFinite(sinceMs)) return all;
  return all.filter((item) => {
    const t = Date.parse(item.created_at);
    return Number.isFinite(t) && t > sinceMs;
  });
}

// Read digest for a user and advance last_seen_at. Returns the pre-update
// cursor, the new cursor, and the items that were new since the prior cursor.
export function consumeWhatsNew(userId, nowIso = new Date().toISOString()) {
  const previous = getLastSeen(userId);
  const items = listChangesSince(previous);
  setLastSeen(userId, nowIso);
  return {
    last_seen_at: previous,
    seen_at: nowIso,
    items
  };
}
