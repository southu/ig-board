// Canonical board scorecard catalog. This is the fallback data source when an
// external Supabase project is not configured and the wire contract for
// GET /api/scorecard. Text fields intentionally preserve the board spec's
// punctuation, symbols, and capitalization.

export const SCORECARD_LAYERS = [
  {
    position: 1,
    name: 'LEADERSHIP ALIGNMENT',
    type: 'MANAGE',
    subtitle: 'Are the two founders operating as one aligned leadership team with clear lanes?'
  },
  {
    position: 2,
    name: 'MANAGEMENT SYSTEMS',
    type: 'MANAGE',
    subtitle: 'Does the environment let capable people succeed?'
  },
  {
    position: 3,
    name: 'CAPABILITIES & EXECUTION',
    type: 'MANAGE',
    subtitle: 'What can the machine do without a founder touching it?'
  },
  {
    position: 4,
    name: 'REVENUE GROWTH',
    type: 'MONITOR',
    subtitle: "Agreed targets — with quality guards so the number can't be gamed."
  },
  {
    position: 5,
    name: 'ENTERPRISE VALUE',
    type: 'MONITOR',
    subtitle: 'The scoreboard, not a dial. Nobody enters this manually except one annual figure.'
  }
];

export const SCORECARD_KPIS = [
  {
    code: '1.1',
    key: 'decision_rights_map_completion',
    name: 'Decision-Rights Map Completion',
    type: 'permanent_kpi',
    layer_position: 1,
    definition: 'Decision-Rights Map Completion; board verifies via document uploaded to this app.',
    owner: 'Zack & Jon jointly',
    cadence: 'monthly until 100% then quarterly reconfirm',
    baseline: '0% — no map exists',
    baseline_source: 'no map exists',
    thresholds: { green: '100% signed', yellow: 'drafted unsigned', red: 'no map' },
    definition_note: null,
    verification: 'document uploaded to this app',
    manual_entry: true
  },
  {
    code: '1.2',
    key: 'bypass_count',
    name: 'Bypass Count',
    type: 'permanent_kpi',
    layer_position: 1,
    definition: 'Bypasses reported by Zack & Jon in a running log, with the board cross-checking each meeting.',
    owner: 'self-reported by Zack & Jon in a running log, board cross-checks each meeting',
    cadence: 'monthly',
    baseline: 'unknown — never counted',
    baseline_source: 'never counted',
    thresholds: { green: '0', yellow: '1–2', red: '3+ or any override without written rationale' },
    definition_note: 'The single most important number on this scorecard.',
    manual_entry: true
  },
  {
    code: '1.3',
    key: 'joint_priorities_document_current',
    name: 'Joint Priorities Document Current',
    type: 'permanent_kpi',
    layer_position: 1,
    definition: 'Whether the joint priorities document is current and signed by both founders.',
    owner: 'Jon',
    cadence: 'quarterly',
    baseline: null,
    baseline_source: null,
    thresholds: { green: 'current and signed by both', yellow: '>1 quarter old', red: 'missing or signed by only one founder' },
    definition_note: null,
    manual_entry: true
  },
  {
    code: '2.1',
    key: 'role_clarity_score',
    name: 'Role Clarity Score',
    type: 'permanent_kpi',
    layer_position: 2,
    definition: 'Role clarity measured by an external survey tool, with results delivered to board and founders simultaneously, never administered or first-read by management.',
    owner: 'External survey tool — results delivered to board and founders simultaneously',
    cadence: 'quarterly',
    baseline: 'never measured',
    baseline_source: 'never measured',
    thresholds: { green: '≥80%', yellow: '65–79%', red: '<65%' },
    definition_note: null,
    manual_entry: true
  },
  {
    code: '2.2',
    key: 'survey_response_rate',
    name: 'Survey Response Rate',
    type: 'permanent_kpi',
    layer_position: 2,
    definition: 'Participation rate in the quarterly role-clarity survey.',
    owner: 'external survey tool',
    cadence: 'quarterly',
    baseline: '~26 responses — low turnout was dismissed',
    baseline_source: 'The last company survey received ~26 responses and low turnout was dismissed.',
    thresholds: { green: '≥85%', yellow: '70–84%', red: '<70%' },
    definition_note: 'The last company survey received ~26 responses and low turnout was dismissed. Participation is itself a trust measurement.',
    manual_entry: true
  },
  {
    code: '2.3',
    key: 'success_criteria_coverage',
    name: 'Success-Criteria Coverage',
    type: 'permanent_kpi',
    layer_position: 2,
    definition: 'Coverage of documented success criteria, with the board sampling two documents at random per quarter.',
    owner: 'department heads report, Jaime compiles',
    cadence: 'quarterly',
    baseline: '~0%',
    baseline_source: '~0%',
    thresholds: {
      green: '100% of managers by Q4 2026, 100% of all roles by mid-2027',
      yellow: null,
      red: null
    },
    green_trajectory: '100% of managers by Q4 2026, 100% of all roles by mid-2027',
    definition_note: null,
    verification: 'sample two documents at random per quarter',
    manual_entry: true
  },
  {
    code: '3.1',
    key: 'time_to_first_revenue',
    name: 'Time to First Revenue',
    type: 'permanent_kpi',
    layer_position: 3,
    definition: 'Time from CRM win date to NetSuite invoice date.',
    owner: 'Jaime, NetSuite invoice dates vs CRM win dates',
    cadence: 'quarterly',
    baseline: '18+ months — Rinnai/Fortune Brands',
    baseline_source: 'Rinnai/Fortune Brands',
    thresholds: { green: '≤6 months', yellow: '7–12', red: '>12' },
    definition_note: null,
    manual_entry: true
  },
  {
    code: '3.2',
    key: 'founder_intervention_count',
    name: 'Founder Intervention Count',
    type: 'permanent_kpi',
    layer_position: 3,
    definition: 'Founder interventions self-reported by Zack in a log, with the board verifying by asking the management team.',
    owner: 'Zack',
    cadence: 'quarterly',
    baseline: '3+ per half-year — DSSI/ESP Plus/Gong examples',
    baseline_source: 'DSSI/ESP Plus/Gong examples',
    thresholds: { green: '0', yellow: '1', red: '2+' },
    definition_note: 'Each intervention is counted as evidence about the system, not credited as a save.',
    verification: 'board cross-checks by asking the management team',
    manual_entry: true
  },
  {
    code: '3.3',
    key: 'customer_touches_per_order',
    name: 'Customer Touches per Order',
    type: 'permanent_kpi',
    layer_position: 3,
    definition: 'Customer touches required per order.',
    owner: 'Enablement/ops owner once hired; Allison until then',
    cadence: 'quarterly',
    baseline: "12–15 touches per management's own June 2026 process documentation across ~12,000 orders/year",
    baseline_source: "management's own June 2026 process documentation across ~12,000 orders/year",
    thresholds: { green: '≤6 by mid-2027', yellow: '7–9', red: '≥10' },
    definition_note: null,
    manual_entry: true
  },
  {
    code: '4.1',
    key: 'revenue_vs_plan',
    name: 'Revenue vs. Plan',
    type: 'permanent_kpi',
    layer_position: 4,
    definition: 'YTD revenue vs seasonalized plan.',
    owner: 'Jaime',
    cadence: 'monthly, YTD vs seasonalized plan',
    baseline: null,
    baseline_source: null,
    plan: '2026 $29M, 2027 $33M, 2028 $35M',
    thresholds: { green: '≥97%', yellow: '90–96%', red: '<90%' },
    definition_note: null,
    manual_entry: true
  },
  {
    code: '4.2',
    key: 'core_net_ordinary_income',
    name: 'Core Net Ordinary Income',
    type: 'permanent_kpi',
    layer_position: 4,
    definition: 'Core net ordinary income; excludes vendor rebates and Applied Production.',
    owner: 'Jaime',
    cadence: 'monthly',
    baseline: 'Jan–May core NOI –$70K 2024, $258K 2025, $354K 2026',
    baseline_source: 'Jan–May core NOI –$70K 2024, $258K 2025, $354K 2026',
    exclusions: 'vendor rebates and Applied Production',
    thresholds: { green: '2027 full-year ≥$1M', yellow: null, red: null },
    definition_note: "Growth bought with margin doesn't count.",
    manual_entry: true
  },
  {
    code: '4.3',
    key: 'customer_concentration',
    name: 'Customer Concentration',
    type: 'permanent_kpi',
    layer_position: 4,
    definition: 'Largest account % of T12M revenue with top-5 % also displayed.',
    owner: 'Jaime',
    cadence: 'quarterly',
    baseline: null,
    baseline_source: null,
    thresholds: { green: '≤20%', yellow: '21–30%', red: '>30%' },
    definition_note: 'Richmond became a single-account business once already.',
    manual_entry: true
  },
  {
    code: '5.1',
    key: 'adjusted_ebitda_ttm',
    name: 'Adjusted EBITDA (TTM)',
    type: 'permanent_kpi',
    layer_position: 5,
    definition: 'Adjusted EBITDA (TTM) per written board-agreed definition.',
    owner: 'Jaime',
    cadence: 'quarterly',
    baseline: null,
    baseline_source: null,
    thresholds: { green: null, yellow: null, red: null },
    definition_note: null,
    manual_entry: true
  },
  {
    code: '5.2',
    key: 'exit_readiness_score',
    name: 'Exit-Readiness Score',
    type: 'computed',
    layer_position: 5,
    definition: 'Computed exit-readiness score; the calculation itself ships in a later step.',
    owner: 'computed',
    cadence: 'computed',
    baseline: null,
    baseline_source: null,
    thresholds: { green: null, yellow: null, red: null },
    definition_note: 'the calculation itself ships in a later step',
    manual_entry: false
  }
];

export const SCORECARD_WATCH_ITEMS = [
  {
    key: 'six_month_rule_pilot_hire',
    name: 'Six-Month Rule — Pilot Hire',
    type: 'special_watch_item',
    layer_position: 2,
    definition: "founder interventions inside the pilot hire's mapped lane",
    thresholds: { green: '0', yellow: null, red: null },
    review: 'reviewed at the January 2027 board meeting then retired or renewed',
    review_at: 'January 2027 board meeting',
    disposition: 'retired or renewed'
  }
];

export function scorecardPayload() {
  return {
    layers: SCORECARD_LAYERS.map((layer) => ({
      ...layer,
      manage: layer.type === 'MANAGE',
      description: layer.subtitle
    })),
    kpis: SCORECARD_KPIS.map((kpi) => ({
      ...kpi,
      thresholds: { ...kpi.thresholds },
      green_threshold: kpi.thresholds.green,
      yellow_threshold: kpi.thresholds.yellow,
      red_threshold: kpi.thresholds.red,
      notes: kpi.definition_note
    })),
    watch_items: SCORECARD_WATCH_ITEMS.map((item) => ({
      ...item,
      thresholds: { ...item.thresholds },
      green_threshold: item.thresholds.green,
      yellow_threshold: item.thresholds.yellow,
      red_threshold: item.thresholds.red
    }))
  };
}
