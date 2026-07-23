// Client helpers for the board agenda generator (Phase 3).
// Network target is always same-origin Fastify /api/agenda* — never a Next route.

import { getSession } from './auth';

const AGENDA_PATH = '/api/agenda';
const REGENERATE_PATH = '/api/agenda/regenerate';

function authHeaders() {
  const session = getSession();
  if (!session || !session.access_token) return null;
  return {
    Authorization: `Bearer ${session.access_token}`,
    'Content-Type': 'application/json'
  };
}

export async function fetchAgenda() {
  const headers = authHeaders();
  if (!headers) {
    return {
      ok: false,
      error: 'unauthenticated',
      message: 'Sign in to load the agenda.',
      status: 401
    };
  }
  try {
    const res = await fetch(AGENDA_PATH, {
      method: 'GET',
      headers,
      cache: 'no-store'
    });
    let body = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    if (!res.ok) {
      return {
        ok: false,
        error: (body && body.error) || 'agenda_failed',
        message: (body && body.message) || 'Failed to load agenda.',
        status: res.status
      };
    }
    return { ok: true, agenda: body.agenda };
  } catch (err) {
    return {
      ok: false,
      error: 'network_error',
      message: (err && err.message) || 'Network error',
      status: 0
    };
  }
}

export async function regenerateAgenda() {
  const headers = authHeaders();
  if (!headers) {
    return {
      ok: false,
      error: 'unauthenticated',
      message: 'Sign in to regenerate the agenda.',
      status: 401
    };
  }
  try {
    const res = await fetch(REGENERATE_PATH, {
      method: 'POST',
      headers,
      body: '{}',
      cache: 'no-store'
    });
    let body = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    if (!res.ok) {
      return {
        ok: false,
        error: (body && body.error) || 'agenda_regenerate_failed',
        message: (body && body.message) || 'Failed to regenerate agenda.',
        status: res.status
      };
    }
    return { ok: true, agenda: body.agenda };
  } catch (err) {
    return {
      ok: false,
      error: 'network_error',
      message: (err && err.message) || 'Network error',
      status: 0
    };
  }
}

// Save founder edits. edited_content is stored separately from generated_content.
export async function saveAgendaEdit(editedContent) {
  const headers = authHeaders();
  if (!headers) {
    return {
      ok: false,
      error: 'unauthenticated',
      message: 'Sign in to edit the agenda.',
      status: 401
    };
  }
  try {
    const res = await fetch(AGENDA_PATH, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ edited_content: editedContent }),
      cache: 'no-store'
    });
    let body = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    if (!res.ok) {
      return {
        ok: false,
        error: (body && body.error) || 'agenda_edit_failed',
        message: (body && body.message) || 'Failed to save agenda edit.',
        status: res.status
      };
    }
    return { ok: true, agenda: body.agenda };
  } catch (err) {
    return {
      ok: false,
      error: 'network_error',
      message: (err && err.message) || 'Network error',
      status: 0
    };
  }
}

// Build a plain-text snapshot of generated topics for the edit textarea default.
export function topicsToEditText(topics) {
  if (!Array.isArray(topics) || topics.length === 0) return '';
  return topics
    .map((t) => {
      const block = t.time_block || t.start_time || '';
      const layer = t.layer_name || `Layer ${t.layer}`;
      return `[${block}] ${layer} — ${t.title}\n${t.body || ''}`.trim();
    })
    .join('\n\n');
}
