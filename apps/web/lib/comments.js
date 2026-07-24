// Client helpers for threaded comments (KPI / memo / analysis).
// Auth: every call forwards the session bearer. No notification side-effects —
// @mentions are pure display (bold/strong) with no email or push.

import { getSession } from './auth';

function authHeaders() {
  const session = getSession();
  const token = session && session.access_token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

// Escape HTML so user-authored comment bodies never inject markup, then bold
// @mentions as <strong class="comment-mention">@name</strong>. Matches
// @handle style tokens (letters, digits, ., _, -).
export function renderCommentBody(body) {
  const raw = body == null ? '' : String(body);
  const escaped = raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
  return escaped.replace(
    /@([A-Za-z0-9._-]+)/g,
    '<strong class="comment-mention">@$1</strong>'
  );
}

// Build a filter query for listComments. Exactly one target key is required.
function targetQuery(target) {
  const t = target && typeof target === 'object' ? target : {};
  if (t.kpi_id) return `kpi_id=${encodeURIComponent(t.kpi_id)}`;
  if (t.memo_id) return `memo_id=${encodeURIComponent(t.memo_id)}`;
  if (t.analysis_id) return `analysis_id=${encodeURIComponent(t.analysis_id)}`;
  return '';
}

// List comments for one entity. Returns { comments } or throws with .status.
export async function fetchComments(target) {
  const q = targetQuery(target);
  if (!q) {
    const err = new Error('target required');
    err.status = 400;
    throw err;
  }
  const res = await fetch(`/api/comments?${q}`, {
    headers: { ...authHeaders() },
    cache: 'no-store'
  });
  if (!res.ok) {
    const err = new Error('comments fetch failed');
    err.status = res.status;
    throw err;
  }
  return res.json();
}

// Create a top-level comment or a reply (parent_id). Returns { comment }.
export async function postComment({
  body,
  parent_id,
  kpi_id,
  memo_id,
  analysis_id
}) {
  const res = await fetch('/api/comments', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ body, parent_id, kpi_id, memo_id, analysis_id })
  });
  if (!res.ok) {
    const err = new Error('comment create failed');
    err.status = res.status;
    try {
      err.body = await res.json();
    } catch {
      /* ignore */
    }
    throw err;
  }
  return res.json();
}

// Resolve or unresolve. Body: { resolved: boolean }.
export async function setCommentResolved(id, resolved) {
  const res = await fetch(`/api/comments/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ resolved: Boolean(resolved) })
  });
  if (!res.ok) {
    const err = new Error('comment resolve failed');
    err.status = res.status;
    throw err;
  }
  return res.json();
}

// Allowed reaction types — must match server REACTION_TYPES.
export const REACTION_TYPES = Object.freeze(['like', 'dislike', 'question']);

// Set / switch / toggle-off the caller's reaction on a comment.
// POST same type twice clears (server toggle). Returns
// { action, reaction_type, my_reaction, comment } or throws with .status.
export async function setCommentReaction(id, type) {
  const res = await fetch(
    `/api/comments/${encodeURIComponent(id)}/reactions`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ type })
    }
  );
  if (!res.ok) {
    const err = new Error('comment reaction failed');
    err.status = res.status;
    try {
      err.body = await res.json();
    } catch {
      /* ignore */
    }
    throw err;
  }
  return res.json();
}

// Explicitly clear the caller's reaction (DELETE). Optional; toggle via
// setCommentReaction(id, sameType) is the primary UI path.
export async function clearCommentReaction(id) {
  const res = await fetch(
    `/api/comments/${encodeURIComponent(id)}/reactions`,
    {
      method: 'DELETE',
      headers: { ...authHeaders() }
    }
  );
  if (!res.ok) {
    const err = new Error('comment reaction clear failed');
    err.status = res.status;
    throw err;
  }
  return res.json();
}

// Optimistic local apply of a reaction click (toggle / switch / set).
// Returns { reaction_counts, my_reaction } for immediate UI update.
export function applyReactionLocally(comment, nextType) {
  const counts = {
    like: 0,
    dislike: 0,
    question: 0,
    ...(comment && comment.reaction_counts ? comment.reaction_counts : {})
  };
  const current = (comment && comment.my_reaction) || null;
  if (current === nextType) {
    counts[nextType] = Math.max(0, (counts[nextType] || 0) - 1);
    return { reaction_counts: counts, my_reaction: null };
  }
  if (current && counts[current] != null) {
    counts[current] = Math.max(0, (counts[current] || 0) - 1);
  }
  counts[nextType] = (counts[nextType] || 0) + 1;
  return { reaction_counts: counts, my_reaction: nextType };
}

// Nest flat comments into a forest by parent_id (roots first, children ordered).
export function nestComments(flat) {
  const list = Array.isArray(flat) ? flat : [];
  const byId = new Map(list.map((c) => [c.id, { ...c, replies: [] }]));
  const roots = [];
  for (const c of byId.values()) {
    if (c.parent_id && byId.has(c.parent_id)) {
      byId.get(c.parent_id).replies.push(c);
    } else {
      roots.push(c);
    }
  }
  return roots;
}

// Stable analysis entity id used by the Independent Analysis page for comments.
// Not a secret; a durable key so threads survive reloads within a deploy.
export const INDEPENDENT_ANALYSIS_ID = 'independent-analysis';
