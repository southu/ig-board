// In-memory board agenda store.
//
// Mirrors commentsStore / store.js: when no external Supabase project is bound,
// this is the live realization of the agendas contract for an un-provisioned
// deploy. generated_content and edited_content are stored SEPARATELY so a
// founder edit never clobbers the generated original, and regenerate/refetch
// never overwrites edited_content.
//
// State is module-scoped (shared across requests in one process) and reset on
// boot. Tests call resetAgendaStore().

import crypto from 'node:crypto';

let state = freshState();

function freshState() {
  return {
    // Single working agenda for the deploy lifetime (board meeting draft).
    agenda: null
  };
}

export function resetAgendaStore() {
  state = freshState();
}

function nextId() {
  return crypto.randomUUID
    ? crypto.randomUUID()
    : `agd_${Date.now().toString(36)}_${crypto.randomBytes(6).toString('hex')}`;
}

// Public wire shape — never includes secrets.
export function publicAgenda(row) {
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    scheduled_for: row.scheduled_for,
    generated_at: row.generated_at,
    updated_at: row.updated_at,
    // Structured generation (topics, time blocks). Immutable across edits.
    generated_content: row.generated_content,
    // Founder edits live only here. null until the first save.
    edited_content: row.edited_content,
    created_by: row.created_by
  };
}

export function getAgenda() {
  return publicAgenda(state.agenda);
}

// Create or replace generated_content. When an agenda already exists, only
// generated_content / generated_at / title / scheduled_for are refreshed —
// edited_content is preserved as-is (regenerate must not clobber edits).
export function setGenerated({
  title,
  scheduledFor,
  generatedContent,
  actorId
} = {}) {
  const now = new Date().toISOString();
  if (!state.agenda) {
    state.agenda = {
      id: nextId(),
      title: title || 'Board Agenda',
      scheduled_for: scheduledFor || null,
      generated_at: now,
      updated_at: now,
      generated_content: generatedContent || null,
      edited_content: null,
      created_by: actorId || null
    };
  } else {
    state.agenda.title = title || state.agenda.title;
    if (scheduledFor !== undefined) state.agenda.scheduled_for = scheduledFor;
    state.agenda.generated_at = now;
    state.agenda.updated_at = now;
    state.agenda.generated_content = generatedContent || null;
    // edited_content intentionally NOT touched.
  }
  return publicAgenda(state.agenda);
}

// Persist founder edits without touching generated_content.
// editedContent may be a string or a structured object (topics/note).
export function setEditedContent(editedContent) {
  if (!state.agenda) {
    const err = new Error('no agenda to edit — generate first');
    err.code = 'NOT_FOUND';
    throw err;
  }
  const now = new Date().toISOString();
  state.agenda.edited_content = editedContent;
  state.agenda.updated_at = now;
  return publicAgenda(state.agenda);
}
