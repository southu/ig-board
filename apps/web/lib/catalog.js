// Static Boardroom scorecard catalog — the canonical five-layer structure and
// KPI definitions, mirroring supabase/seed.sql (layers keyed by position, KPIs
// by key). This is product structure, not data: it lets the pyramid and layer
// detail pages render their full shape (labels, owners, targets, the deliberate
// gray empty state) even before any KPI *values* exist. Observed values arrive
// separately from GET /api/kpi-values and are merged in by key at runtime.
//
// Layers 1-3 are MANAGE (the board actively steers them); 4-5 are MONITOR.
// The pyramid stacks them apex (layer 1, narrowest) to base (layer 5, widest).

export const LAYERS = [
  {
    position: 1,
    name: 'Financial Health',
    description:
      "Revenue, margin, and cash — the board's primary financial dials.",
    manage: true
  },
  {
    position: 2,
    name: 'Order Operations',
    description: 'How efficiently orders flow from intake to delivery.',
    manage: true
  },
  {
    position: 3,
    name: 'Sales & Growth',
    description: 'Pipeline, bookings, and customer expansion.',
    manage: true
  },
  {
    position: 4,
    name: 'Customer & Quality',
    description: 'Customer sentiment and quality outcomes (monitored).',
    manage: false
  },
  {
    position: 5,
    name: 'People & Organization',
    description: 'Team health and organizational leverage (monitored).',
    manage: false
  }
];

// KPI catalog. Thresholds + direction drive the client-side RAG computation
// (see lib/rag.js). `green`/`yellow`/`red` are ordered tier thresholds; a null
// tier collapses. `targetMin`/`targetMax` back the target_band direction.
export const KPIS = [
  // Layer 1 — Financial Health
  { key: 'revenue_plan_fy1', name: 'Revenue Plan FY1', owner: 'CFO', cadence: 'annual', layer: 1, direction: 'up_good', unit: 'USD', green: 29000000, yellow: null, red: null, targetMin: null, targetMax: null },
  { key: 'revenue_plan_fy2', name: 'Revenue Plan FY2', owner: 'CFO', cadence: 'annual', layer: 1, direction: 'up_good', unit: 'USD', green: 33000000, yellow: null, red: null, targetMin: null, targetMax: null },
  { key: 'revenue_plan_fy3', name: 'Revenue Plan FY3', owner: 'CFO', cadence: 'annual', layer: 1, direction: 'up_good', unit: 'USD', green: 35000000, yellow: null, red: null, targetMin: null, targetMax: null },
  { key: 'gross_margin_pct', name: 'Gross Margin %', owner: 'CFO', cadence: 'monthly', layer: 1, direction: 'up_good', unit: '%', green: 38, yellow: 34, red: 30, targetMin: null, targetMax: null },
  { key: 'ebitda_margin_pct', name: 'EBITDA Margin %', owner: 'CFO', cadence: 'monthly', layer: 1, direction: 'up_good', unit: '%', green: 12, yellow: 8, red: 5, targetMin: null, targetMax: null },
  { key: 'cash_runway_months', name: 'Cash Runway (months)', owner: 'CFO', cadence: 'monthly', layer: 1, direction: 'up_good', unit: 'months', green: 9, yellow: 6, red: 3, targetMin: null, targetMax: null },

  // Layer 2 — Order Operations
  { key: 'bypass_count', name: 'Bypass Count', owner: 'COO', cadence: 'weekly', layer: 2, direction: 'down_good', unit: 'count', green: 0, yellow: 2, red: 3, targetMin: null, targetMax: null },
  { key: 'touches_per_order', name: 'Touches per Order', owner: 'COO', cadence: 'weekly', layer: 2, direction: 'down_good', unit: 'touches', green: 6, yellow: null, red: null, targetMin: 12, targetMax: 15 },
  { key: 'on_time_delivery_pct', name: 'On-Time Delivery %', owner: 'COO', cadence: 'weekly', layer: 2, direction: 'up_good', unit: '%', green: 97, yellow: 93, red: 90, targetMin: null, targetMax: null },
  { key: 'order_error_rate', name: 'Order Error Rate %', owner: 'COO', cadence: 'weekly', layer: 2, direction: 'down_good', unit: '%', green: 1, yellow: 3, red: 5, targetMin: null, targetMax: null },
  { key: 'avg_order_cycle_days', name: 'Avg Order Cycle (days)', owner: 'COO', cadence: 'weekly', layer: 2, direction: 'down_good', unit: 'days', green: 5, yellow: 8, red: 12, targetMin: null, targetMax: null },
  { key: 'supplier_defect_rate', name: 'Supplier Defect Rate %', owner: 'COO', cadence: 'monthly', layer: 2, direction: 'down_good', unit: '%', green: 1, yellow: 2, red: 4, targetMin: null, targetMax: null },

  // Layer 3 — Sales & Growth
  { key: 'new_bookings', name: 'New Bookings', owner: 'CRO', cadence: 'monthly', layer: 3, direction: 'up_good', unit: 'USD', green: 2500000, yellow: 1800000, red: 1200000, targetMin: null, targetMax: null },
  { key: 'pipeline_coverage_ratio', name: 'Pipeline Coverage Ratio', owner: 'CRO', cadence: 'monthly', layer: 3, direction: 'up_good', unit: 'x', green: 3, yellow: 2, red: 1.5, targetMin: null, targetMax: null },
  { key: 'win_rate_pct', name: 'Win Rate %', owner: 'CRO', cadence: 'monthly', layer: 3, direction: 'up_good', unit: '%', green: 30, yellow: 22, red: 15, targetMin: null, targetMax: null },
  { key: 'repeat_customer_rate', name: 'Repeat Customer Rate %', owner: 'CRO', cadence: 'monthly', layer: 3, direction: 'up_good', unit: '%', green: 60, yellow: 45, red: 35, targetMin: null, targetMax: null },
  { key: 'avg_order_value', name: 'Average Order Value', owner: 'CRO', cadence: 'monthly', layer: 3, direction: 'up_good', unit: 'USD', green: 4000, yellow: 3000, red: 2000, targetMin: null, targetMax: null },

  // Layer 4 — Customer & Quality (monitored)
  { key: 'nps', name: 'Net Promoter Score', owner: 'VP Customer', cadence: 'quarterly', layer: 4, direction: 'up_good', unit: 'score', green: 50, yellow: 30, red: 10, targetMin: null, targetMax: null },
  { key: 'customer_churn_rate', name: 'Customer Churn Rate %', owner: 'VP Customer', cadence: 'quarterly', layer: 4, direction: 'down_good', unit: '%', green: 5, yellow: 10, red: 15, targetMin: null, targetMax: null },
  { key: 'quote_turnaround_hours', name: 'Quote Turnaround (hours)', owner: 'VP Customer', cadence: 'weekly', layer: 4, direction: 'down_good', unit: 'hours', green: 24, yellow: 48, red: 72, targetMin: null, targetMax: null },
  { key: 'reorder_rate', name: 'Reorder Rate %', owner: 'VP Customer', cadence: 'monthly', layer: 4, direction: 'up_good', unit: '%', green: 40, yellow: 30, red: 20, targetMin: null, targetMax: null },

  // Layer 5 — People & Organization (monitored)
  { key: 'employee_enps', name: 'Employee eNPS', owner: 'VP People', cadence: 'quarterly', layer: 5, direction: 'up_good', unit: 'score', green: 30, yellow: 10, red: 0, targetMin: null, targetMax: null },
  { key: 'voluntary_turnover_rate', name: 'Voluntary Turnover Rate %', owner: 'VP People', cadence: 'quarterly', layer: 5, direction: 'down_good', unit: '%', green: 8, yellow: 14, red: 20, targetMin: null, targetMax: null },
  { key: 'revenue_per_employee', name: 'Revenue per Employee', owner: 'VP People', cadence: 'quarterly', layer: 5, direction: 'up_good', unit: 'USD', green: 300000, yellow: 250000, red: 200000, targetMin: null, targetMax: null },
  { key: 'training_hours_per_fte', name: 'Training Hours per FTE', owner: 'VP People', cadence: 'quarterly', layer: 5, direction: 'up_good', unit: 'hours', green: 40, yellow: 20, red: 10, targetMin: null, targetMax: null }
];

export function layerByPosition(position) {
  return LAYERS.find((l) => l.position === Number(position)) || null;
}

export function kpisForLayer(position) {
  return KPIS.filter((k) => k.layer === Number(position));
}
