'use client';

import { useCallback, useEffect, useState } from 'react';
import { getSession } from './auth';

// Client helpers for the Phase 1 founder workflow — role resolution, KPI value
// entry, definition editing, the definition-changed flag, and the audit view.
// Every call forwards the stored session bearer so the same-origin auth boundary
// (and the founder-only role gate) applies. Board sessions can READ definitions
// but every write / the audit view returns 403 — surfaced to the caller so the
// UI can stay read-only for the board.

function authHeaders() {
  const session = getSession();
  const token = session && session.access_token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

// Resolve the signed-in member's app role (and identity/capabilities) from
// GET /me. Returns { role, userId, capabilities, loading }.
// role/userId are null until resolved or when unauthenticated. This is the
// single gate the UI uses to decide whether to render founder controls — so
// the board never sees an Update form or button in the DOM. Comment delete
// also uses userId + capabilities (delete_any_comment).
export function useRole() {
  const [role, setRole] = useState(null);
  const [userId, setUserId] = useState(null);
  const [capabilities, setCapabilities] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    const session = getSession();
    if (!session || !session.access_token) {
      setLoading(false);
      return;
    }
    fetch('/me', { headers: authHeaders(), cache: 'no-store' })
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => {
        if (!alive) return;
        setRole((body && body.role) || null);
        setUserId((body && (body.id || body.user_id)) || null);
        setCapabilities(
          Array.isArray(body && body.capabilities) ? body.capabilities : []
        );
        setLoading(false);
      })
      .catch(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  return { role, userId, capabilities, loading };
}

// KPI definitions + the derived 90-day "definition changed" flag, keyed by KPI
// key. Both roles may read. Returns { definitions, loading, reload }.
export function useDefinitions() {
  const [definitions, setDefinitions] = useState({});
  const [loading, setLoading] = useState(true);

  const reload = useCallback(() => {
    setLoading(true);
    return fetch('/api/kpi-definitions', { headers: authHeaders(), cache: 'no-store' })
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => {
        setDefinitions((body && body.definitions) || {});
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  return { definitions, loading, reload };
}

// Founder value entry. Resolves { ok: true } on success or throws with the HTTP
// status attached so the form can show an honest error (e.g. 403 for a board
// session, 400 for validation).
export async function submitKpiValue({ key, period, value, note }) {
  const res = await fetch('/api/kpi-values', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ key, period, value: Number(value), note })
  });
  if (!res.ok) {
    const err = new Error('value submit failed');
    err.status = res.status;
    throw err;
  }
  return res.json();
}

// Founder definition/threshold edit. `patch` may include `definition` and any
// threshold field. Throws with `.status` on failure.
export async function submitDefinition(key, patch) {
  const res = await fetch(`/api/kpi-definitions/${encodeURIComponent(key)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(patch)
  });
  if (!res.ok) {
    const err = new Error('definition submit failed');
    err.status = res.status;
    throw err;
  }
  return res.json();
}

// Founder-visible audit trail (who/when/old/new), newest first. Returns
// { entries, loading, reload }; entries is [] for a board session (403).
export function useAudit() {
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(() => {
    setLoading(true);
    return fetch('/api/audit-log', { headers: authHeaders(), cache: 'no-store' })
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => {
        setEntries((body && body.entries) || []);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  return { entries, loading, reload };
}
