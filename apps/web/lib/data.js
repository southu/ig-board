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
    return normalizeValues((body && body.values) || {});
  } catch {
    return {};
  }
}

// Normalize the observed values into period-ascending order per KPI. The API
// already sorts (order=period.asc) and `period` is an ISO date string
// (YYYY-MM-DD, so lexical order == chronological), but the client's "latest =
// last point" and the 6-period sparkline both depend on that ordering — sorting
// here keeps the RAG + sparkline correct even if an upstream path ever delivers
// values out of order. Pure and defensive; never throws.
export function normalizeValues(valuesByKey) {
  if (!valuesByKey || typeof valuesByKey !== 'object') return {};
  const out = {};
  for (const key of Object.keys(valuesByKey)) {
    const series = valuesByKey[key];
    if (!Array.isArray(series)) continue;
    out[key] = series
      .slice()
      .sort((a, b) => String(a.period).localeCompare(String(b.period)));
  }
  return out;
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
