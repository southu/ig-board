// Embedded demo KPI seed — the committed `kpi_values` the Boardroom ships with
// when NO external Supabase project is provisioned onto this deploy.
//
// Why this exists: the live acceptance path needs at least one real KPI series
// so a layer band computes a non-gray RAG and its detail card renders a
// 6-period sparkline. The canonical source for that series is the Supabase
// `kpi_values` table, read server-side with the service role (see
// GET /api/kpi-values). But when the service-role project isn't wired (the
// current un-provisioned state), that table is unreachable and every band would
// stay gray. Rather than dead-end, GET /api/kpi-values serves THIS committed
// seed as a demo fallback — it is the faithful, in-repo realization of "seed at
// least one kpi_values row" for a deployment that has no reachable database.
//
// Scope is deliberate: only Layer 1 (Financial Health) KPIs carry values, and
// only for a few of its KPIs, so:
//   - Layer 1's band is NON-gray and takes its WORST KPI's color (cash runway
//     trends into the red tier -> red band), exercising the worst-status roll-up.
//   - Layers 2-5 carry NO values, so they keep the deliberate gray no-data state
//     in both themes. The seeded + empty layers coexist on one page load.
//
// Keys match apps/web/lib/catalog.js (and supabase/seed.sql). Periods are ISO
// dates in ascending order — six consecutive months — matching the real API's
// `order=period.asc` contract so the client's "latest = last point" and the
// 6-period sparkline read correctly. Values are non-secret demo observations.
//
// This is a FALLBACK only: the moment a real Supabase admin project is bound
// (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY), GET /api/kpi-values reads the live
// table instead and this seed is never served. See apps/api/src/server.js.

const PERIODS = [
  '2026-02-01',
  '2026-03-01',
  '2026-04-01',
  '2026-05-01',
  '2026-06-01',
  '2026-07-01'
];

function series(values) {
  return values.map((value, i) => ({ period: PERIODS[i], value }));
}

// Layer 1 — Financial Health. cash_runway_months trends down into the red tier
// (green >= 9, yellow >= 6, red >= 3, up_good) so it is the layer's WORST KPI
// and drives the band red; gross margin lands amber, EBITDA lands green.
export const SEED_KPI_VALUES = {
  cash_runway_months: series([8, 7, 6, 5, 4, 2]),
  gross_margin_pct: series([33, 34, 35, 35, 36, 37]),
  ebitda_margin_pct: series([7, 8, 9, 10, 11, 12])
};
