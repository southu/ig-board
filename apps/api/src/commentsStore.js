// Boardroom threaded comments — polymorphic attachment + resolve + replies.
//
// Why this exists (and why it is in-memory): the live deployment runs with NO
// external Supabase project bound (isAdminConfigured() === false), so the
// canonical `comments` table is unreachable. This module is the faithful
// in-process realization of that contract for an un-provisioned deploy:
//   * exactly one of kpi_id / memo_id / analysis_id (CHECK num_nonnulls = 1)
//   * optional parent_id for reply threads (self-referential)
//   * resolved boolean for resolve / unresolve
//   * both founder and board may author; auth is enforced at the API boundary
//
// State is module-scoped so every request in the Railway process shares it
// (what the live tester needs within a deploy lifetime) and starts fresh on
// each boot. Tests reset with resetCommentsStore().
// No notifications, email, or push are ever emitted from this module.

import crypto from 'node:crypto';

let state = freshState();

function freshState() {
  return {
    // id -> comment row
    comments: new Map()
  };
}

export function resetCommentsStore() {
  state = freshState();
}

function nextId() {
  return crypto.randomUUID
    ? crypto.randomUUID()
    : `cmt_${Date.now().toString(36)}_${crypto.randomBytes(6).toString('hex')}`;
}

// Public wire shape (never includes secrets).
export function publicComment(row) {
  if (!row) return null;
  return {
    id: row.id,
    author_id: row.author_id,
    author_email: row.author_email,
    author_role: row.author_role,
    parent_id: row.parent_id,
    kpi_id: row.kpi_id,
    memo_id: row.memo_id,
    analysis_id: row.analysis_id,
    body: row.body,
    resolved: Boolean(row.resolved),
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

// Count non-null targets — mirrors PG num_nonnulls(kpi_id, memo_id, analysis_id).
function targetCount({ kpi_id, memo_id, analysis_id }) {
  let n = 0;
  if (kpi_id) n += 1;
  if (memo_id) n += 1;
  if (analysis_id) n += 1;
  return n;
}

// Normalize an optional string id: trim, empty -> null.
function normId(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s.length > 0 ? s : null;
}

// Create a comment. Throws Error with .code:
//   'VALIDATION' — missing body, wrong target count, parent not found / mismatch
// Returns the public row.
export function createComment({
  authorId,
  authorEmail,
  authorRole,
  body,
  parentId,
  kpiId,
  memoId,
  analysisId
}) {
  const text = typeof body === 'string' ? body.trim() : '';
  if (!text) {
    const err = new Error('body required');
    err.code = 'VALIDATION';
    throw err;
  }

  let kpi_id = normId(kpiId);
  let memo_id = normId(memoId);
  let analysis_id = normId(analysisId);
  let parent_id = normId(parentId);

  // Replies inherit the parent's target so the polymorphic CHECK stays true
  // and the child is listed with its thread.
  if (parent_id) {
    const parent = state.comments.get(parent_id);
    if (!parent) {
      const err = new Error('parent comment not found');
      err.code = 'VALIDATION';
      throw err;
    }
    // Prefer explicit targets when provided; otherwise inherit.
    if (!kpi_id && !memo_id && !analysis_id) {
      kpi_id = parent.kpi_id;
      memo_id = parent.memo_id;
      analysis_id = parent.analysis_id;
    } else {
      // Child must attach to the same entity as its parent.
      const same =
        (kpi_id || null) === (parent.kpi_id || null) &&
        (memo_id || null) === (parent.memo_id || null) &&
        (analysis_id || null) === (parent.analysis_id || null);
      if (!same) {
        const err = new Error('reply target must match parent');
        err.code = 'VALIDATION';
        throw err;
      }
    }
  }

  if (targetCount({ kpi_id, memo_id, analysis_id }) !== 1) {
    const err = new Error(
      'exactly one of kpi_id, memo_id, analysis_id is required'
    );
    err.code = 'VALIDATION';
    throw err;
  }

  const now = new Date().toISOString();
  const row = {
    id: nextId(),
    author_id: authorId || null,
    author_email: authorEmail || null,
    author_role: authorRole || null,
    parent_id,
    kpi_id,
    memo_id,
    analysis_id,
    body: text,
    resolved: false,
    created_at: now,
    updated_at: now
  };
  state.comments.set(row.id, row);
  return publicComment(row);
}

export function getComment(id) {
  return publicComment(state.comments.get(normId(id)) || null);
}

// List comments for exactly one target. Returns oldest-first (thread order).
// When filter is empty / multi-target, returns [] (callers should 400 first).
export function listComments({ kpiId, memoId, analysisId } = {}) {
  const kpi_id = normId(kpiId);
  const memo_id = normId(memoId);
  const analysis_id = normId(analysisId);
  if (targetCount({ kpi_id, memo_id, analysis_id }) !== 1) return [];

  const rows = [...state.comments.values()].filter((r) => {
    if (kpi_id) return r.kpi_id === kpi_id;
    if (memo_id) return r.memo_id === memo_id;
    return r.analysis_id === analysis_id;
  });
  rows.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  return rows.map(publicComment);
}

// Set resolved true/false. Returns public row or null if missing.
export function setResolved(id, resolved) {
  const row = state.comments.get(normId(id));
  if (!row) return null;
  row.resolved = Boolean(resolved);
  row.updated_at = new Date().toISOString();
  state.comments.set(row.id, row);
  return publicComment(row);
}

export function commentCount() {
  return state.comments.size;
}
