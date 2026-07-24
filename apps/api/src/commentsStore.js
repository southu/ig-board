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
//   * comment reactions: one row per (comment_id, user_id) — Map key is the
//     uniqueness constraint; setReaction upserts / toggles against that key
//
// State is module-scoped so every request in the Railway process shares it
// (what the live tester needs within a deploy lifetime) and starts fresh on
// each boot. Tests reset with resetCommentsStore().
// No notifications, email, or push are ever emitted from this module.

import crypto from 'node:crypto';

export const REACTION_TYPES = Object.freeze(['like', 'dislike', 'question']);

let state = freshState();

function freshState() {
  return {
    // id -> comment row
    comments: new Map(),
    // uniqueness: one reaction per user per comment (key = `${commentId}\0${userId}`)
    // value: { comment_id, user_id, reaction_type, created_at, updated_at }
    reactions: new Map()
  };
}

export function resetCommentsStore() {
  state = freshState();
}

function reactionKey(commentId, userId) {
  return `${commentId}\0${userId}`;
}

function emptyReactionCounts() {
  return { like: 0, dislike: 0, question: 0 };
}

export function isReactionType(type) {
  return REACTION_TYPES.includes(type);
}

function nextId() {
  return crypto.randomUUID
    ? crypto.randomUUID()
    : `cmt_${Date.now().toString(36)}_${crypto.randomBytes(6).toString('hex')}`;
}

// True when the row has been soft-deleted (deleted_at set).
export function isCommentDeleted(row) {
  return Boolean(row && row.deleted_at);
}

// Public wire shape (never includes secrets or soft-delete internals).
// When viewerUserId is provided (or includeReactions is true), attaches
// reaction_counts + my_reaction so list payloads stay self-contained.
// Soft-deleted comments are never exposed on the public wire.
export function publicComment(row, { viewerUserId = null, includeReactions = false } = {}) {
  if (!row || isCommentDeleted(row)) return null;
  const base = {
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
  if (includeReactions || viewerUserId != null) {
    return {
      ...base,
      ...reactionSummaryForComment(row.id, viewerUserId)
    };
  }
  return base;
}

// Internal row lookup (includes soft-deleted). Used by authz for DELETE.
export function getCommentRow(id) {
  return state.comments.get(normId(id)) || null;
}

// Aggregate counts + caller's own reaction for one comment.
// Soft-deleted comments contribute zero to reaction totals.
export function reactionSummaryForComment(commentId, viewerUserId) {
  const id = normId(commentId);
  const counts = emptyReactionCounts();
  let my_reaction = null;
  if (!id) {
    return { reaction_counts: counts, my_reaction };
  }
  const row = state.comments.get(id);
  if (!row || isCommentDeleted(row)) {
    return { reaction_counts: counts, my_reaction };
  }
  const viewer = viewerUserId != null ? String(viewerUserId) : null;
  for (const r of state.reactions.values()) {
    if (r.comment_id !== id) continue;
    if (counts[r.reaction_type] != null) counts[r.reaction_type] += 1;
    if (viewer && r.user_id === viewer) my_reaction = r.reaction_type;
  }
  return { reaction_counts: counts, my_reaction };
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
    // Soft-delete fields (schema parity with public.comments). Existing list/
    // get paths intentionally ignore these so visible behavior is unchanged.
    deleted_at: null,
    deleted_by: null,
    created_at: now,
    updated_at: now
  };
  state.comments.set(row.id, row);
  return publicComment(row);
}

// Public get — soft-deleted comments are not found (null).
export function getComment(id) {
  return publicComment(state.comments.get(normId(id)) || null);
}

// List comments for exactly one target. Returns oldest-first (thread order).
// Soft-deleted comments are excluded. When filter is empty / multi-target,
// returns [] (callers should 400 first).
// viewerUserId (optional) drives my_reaction; reaction_counts always included
// so clients can render tallies without a second round-trip.
export function listComments({ kpiId, memoId, analysisId, viewerUserId = null } = {}) {
  const kpi_id = normId(kpiId);
  const memo_id = normId(memoId);
  const analysis_id = normId(analysisId);
  if (targetCount({ kpi_id, memo_id, analysis_id }) !== 1) return [];

  const rows = [...state.comments.values()].filter((r) => {
    if (isCommentDeleted(r)) return false;
    if (kpi_id) return r.kpi_id === kpi_id;
    if (memo_id) return r.memo_id === memo_id;
    return r.analysis_id === analysis_id;
  });
  rows.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  return rows.map((r) =>
    publicComment(r, { viewerUserId, includeReactions: true })
  );
}

// All non-deleted comments across every target (oldest-first). Used by the
// agenda generator to collect unresolved discussion into time-blocked topics.
export function listAllComments() {
  const rows = [...state.comments.values()].filter((r) => !isCommentDeleted(r));
  rows.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  return rows.map(publicComment);
}

// Soft-delete a comment: set deleted_at + deleted_by. Never hard-deletes.
// Returns { ok: true, id } on success.
// Throws Error with .code:
//   'NOT_FOUND' — missing or already soft-deleted
//   'VALIDATION' — missing deletedBy
export function softDeleteComment({ id, deletedBy }) {
  const comment_id = normId(id);
  const deleted_by =
    deletedBy != null && String(deletedBy).trim() !== ''
      ? String(deletedBy).trim()
      : null;
  if (!deleted_by) {
    const err = new Error('deleted_by required');
    err.code = 'VALIDATION';
    throw err;
  }
  const row = state.comments.get(comment_id);
  if (!row || isCommentDeleted(row)) {
    const err = new Error('comment not found');
    err.code = 'NOT_FOUND';
    throw err;
  }
  const now = new Date().toISOString();
  row.deleted_at = now;
  row.deleted_by = deleted_by;
  row.updated_at = now;
  state.comments.set(row.id, row);
  return { ok: true, id: row.id, deleted_at: row.deleted_at, deleted_by: row.deleted_by };
}

// Unresolved comments only (resolved excluded). Root + replies both listed;
// the agenda generator further filters to top-level topics.
export function listUnresolvedComments() {
  return listAllComments().filter((c) => c && !c.resolved);
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

// ---------------------------------------------------------------------------
// Comment reactions — one row per (comment_id, user_id).
// Uniqueness is enforced by the Map key (mirrors UNIQUE(comment_id, user_id)).
// setReaction upserts on that key; posting the same type toggles the row off.
// ---------------------------------------------------------------------------

// Upsert or toggle a reaction for (commentId, userId).
// Returns:
//   { action: 'set'|'cleared'|'switched', reaction_type, comment }
// Throws Error with .code:
//   'NOT_FOUND'   — comment missing
//   'VALIDATION'  — bad type / missing user
export function setReaction({ commentId, userId, type }) {
  const comment_id = normId(commentId);
  const user_id = userId != null ? String(userId).trim() : '';
  const reaction_type = typeof type === 'string' ? type.trim().toLowerCase() : '';

  const target = comment_id ? state.comments.get(comment_id) : null;
  if (!target || isCommentDeleted(target)) {
    const err = new Error('comment not found');
    err.code = 'NOT_FOUND';
    throw err;
  }
  if (!user_id) {
    const err = new Error('user required');
    err.code = 'VALIDATION';
    throw err;
  }
  if (!isReactionType(reaction_type)) {
    const err = new Error(
      `reaction type must be one of: ${REACTION_TYPES.join(', ')}`
    );
    err.code = 'VALIDATION';
    throw err;
  }

  const key = reactionKey(comment_id, user_id);
  const existing = state.reactions.get(key);
  const now = new Date().toISOString();

  // Toggle off: posting the same type the user already holds clears the row.
  if (existing && existing.reaction_type === reaction_type) {
    state.reactions.delete(key);
    return {
      action: 'cleared',
      reaction_type: null,
      comment: publicComment(state.comments.get(comment_id), {
        viewerUserId: user_id,
        includeReactions: true
      })
    };
  }

  // Upsert on unique (comment_id, user_id) — insert or replace type.
  if (existing) {
    existing.reaction_type = reaction_type;
    existing.updated_at = now;
    state.reactions.set(key, existing);
    return {
      action: 'switched',
      reaction_type,
      comment: publicComment(state.comments.get(comment_id), {
        viewerUserId: user_id,
        includeReactions: true
      })
    };
  }

  state.reactions.set(key, {
    comment_id,
    user_id,
    reaction_type,
    created_at: now,
    updated_at: now
  });
  return {
    action: 'set',
    reaction_type,
    comment: publicComment(state.comments.get(comment_id), {
      viewerUserId: user_id,
      includeReactions: true
    })
  };
}

// Explicitly clear the caller's reaction on a comment (no-op if none).
// Returns { action: 'cleared', reaction_type: null, comment } or throws NOT_FOUND.
export function clearReaction({ commentId, userId }) {
  const comment_id = normId(commentId);
  const user_id = userId != null ? String(userId).trim() : '';

  const target = comment_id ? state.comments.get(comment_id) : null;
  if (!target || isCommentDeleted(target)) {
    const err = new Error('comment not found');
    err.code = 'NOT_FOUND';
    throw err;
  }
  if (!user_id) {
    const err = new Error('user required');
    err.code = 'VALIDATION';
    throw err;
  }

  const key = reactionKey(comment_id, user_id);
  state.reactions.delete(key);
  return {
    action: 'cleared',
    reaction_type: null,
    comment: publicComment(state.comments.get(comment_id), {
      viewerUserId: user_id,
      includeReactions: true
    })
  };
}

// Test / introspection helpers.
export function reactionCount() {
  return state.reactions.size;
}

export function getUserReaction(commentId, userId) {
  const key = reactionKey(normId(commentId), String(userId || '').trim());
  const row = state.reactions.get(key);
  return row ? row.reaction_type : null;
}
