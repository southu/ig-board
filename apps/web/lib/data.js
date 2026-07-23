'use client';

import { useEffect, useState } from 'react';
import { getSession } from './auth';

// Fetch observed KPI values from the same-origin API. The server reads them with
// its service role (see apps/api GET /api/kpi-values) so the browser never needs
// the Supabase anon key; we just forward the user's session token so the auth
// boundary passes. Returns { <kpiKey>: [{ period, value }] } (period-ascending),
// or {} on any failure — the UI then shows its gray no-data state.
export async function fetchKpiValues() {
  const session = getSession();
  if (!session || !session.access_token) return {};
  try {
    const res = await fetch('/api/kpi-values', {
      headers: { Authorization: `Bearer ${session.access_token}` },
      cache: 'no-store'
    });
    if (!res.ok) return {};
    const body = await res.json();
    return (body && body.values) || {};
  } catch {
    return {};
  }
}

// React hook: load KPI values once after mount (client-only, post-auth). Returns
// { valuesByKey, loading }. Never throws; failures resolve to an empty map.
export function useKpiValues() {
  const [valuesByKey, setValuesByKey] = useState(null);

  useEffect(() => {
    let alive = true;
    fetchKpiValues().then((v) => {
      if (alive) setValuesByKey(v || {});
    });
    return () => {
      alive = false;
    };
  }, []);

  return { valuesByKey: valuesByKey || {}, loading: valuesByKey === null };
}
