// Static UI projection of the canonical catalog exposed by GET /api/scorecard.
// Board-spec prose comes directly from the API's canonical seed so punctuation
// and capitalization cannot drift between the database/API and rendered cards.
import { SCORECARD_KPIS } from '../../api/src/scorecardData.js';
export const LAYERS = [
  { position: 1, name: 'LEADERSHIP ALIGNMENT', description: 'Are the two founders operating as one aligned leadership team with clear lanes?', manage: true },
  { position: 2, name: 'MANAGEMENT SYSTEMS', description: 'Does the environment let capable people succeed?', manage: true },
  { position: 3, name: 'CAPABILITIES & EXECUTION', description: 'What can the machine do without a founder touching it?', manage: true },
  { position: 4, name: 'REVENUE GROWTH', description: "Agreed targets — with quality guards so the number can't be gamed.", manage: false },
  { position: 5, name: 'ENTERPRISE VALUE', description: 'The scoreboard, not a dial. Nobody enters this manually except one annual figure.', manage: false }
];

const KPI_RUNTIME = [
  { code: '1.1', key: 'decision_rights_map_completion', name: 'Decision-Rights Map Completion', owner: 'Zack & Jon jointly', cadence: 'monthly until 100% then quarterly reconfirm', layer: 1, direction: 'up_good', unit: '%', green: 100, yellow: null, red: null, targetMin: null, targetMax: null, manualEntry: true },
  { code: '1.2', key: 'bypass_count', name: 'Bypass Count', owner: 'self-reported by Zack & Jon in a running log, board cross-checks each meeting', cadence: 'monthly', layer: 1, direction: 'down_good', unit: 'count', green: 0, yellow: 2, red: 3, targetMin: null, targetMax: null, manualEntry: true },
  { code: '1.3', key: 'joint_priorities_document_current', name: 'Joint Priorities Document Current', owner: 'Jon', cadence: 'quarterly', layer: 1, direction: 'up_good', unit: 'status', green: 1, yellow: null, red: null, targetMin: null, targetMax: null, manualEntry: true },
  { code: '2.1', key: 'role_clarity_score', name: 'Role Clarity Score', owner: 'External survey tool — results delivered to board and founders simultaneously', cadence: 'quarterly', layer: 2, direction: 'up_good', unit: '%', green: 80, yellow: 65, red: null, targetMin: null, targetMax: null, manualEntry: true },
  { code: '2.2', key: 'survey_response_rate', name: 'Survey Response Rate', owner: 'external survey tool', cadence: 'quarterly', layer: 2, direction: 'up_good', unit: '%', green: 85, yellow: 70, red: null, targetMin: null, targetMax: null, manualEntry: true },
  { code: '2.3', key: 'success_criteria_coverage', name: 'Success-Criteria Coverage', owner: 'department heads report, Jaime compiles', cadence: 'quarterly', layer: 2, direction: 'up_good', unit: '%', green: 100, yellow: null, red: null, targetMin: null, targetMax: null, manualEntry: true },
  { code: '3.1', key: 'time_to_first_revenue', name: 'Time to First Revenue', owner: 'Jaime, NetSuite invoice dates vs CRM win dates', cadence: 'quarterly', layer: 3, direction: 'down_good', unit: 'months', green: 6, yellow: 12, red: null, targetMin: null, targetMax: null, manualEntry: true },
  { code: '3.2', key: 'founder_intervention_count', name: 'Founder Intervention Count', owner: 'Zack', cadence: 'quarterly', layer: 3, direction: 'down_good', unit: 'count', green: 0, yellow: 1, red: 2, targetMin: null, targetMax: null, manualEntry: true },
  { code: '3.3', key: 'customer_touches_per_order', name: 'Customer Touches per Order', owner: 'Enablement/ops owner once hired; Allison until then', cadence: 'quarterly', layer: 3, direction: 'down_good', unit: 'touches', green: 6, yellow: 9, red: 10, targetMin: null, targetMax: null, manualEntry: true },
  { code: '4.1', key: 'revenue_vs_plan', name: 'Revenue vs. Plan', owner: 'Jaime', cadence: 'monthly, YTD vs seasonalized plan', layer: 4, direction: 'up_good', unit: '%', green: 97, yellow: 90, red: null, targetMin: null, targetMax: null, manualEntry: true },
  { code: '4.2', key: 'core_net_ordinary_income', name: 'Core Net Ordinary Income', owner: 'Jaime', cadence: 'monthly', layer: 4, direction: 'up_good', unit: 'USD', green: 1000000, yellow: null, red: null, targetMin: null, targetMax: null, manualEntry: true },
  { code: '4.3', key: 'customer_concentration', name: 'Customer Concentration', owner: 'Jaime', cadence: 'quarterly', layer: 4, direction: 'down_good', unit: '%', green: 20, yellow: 30, red: null, targetMin: null, targetMax: null, manualEntry: true },
  { code: '5.1', key: 'adjusted_ebitda_ttm', name: 'Adjusted EBITDA (TTM)', owner: 'Jaime', cadence: 'quarterly', layer: 5, direction: 'up_good', unit: 'USD', green: null, yellow: null, red: null, targetMin: null, targetMax: null, manualEntry: true },
  { code: '5.2', key: 'exit_readiness_score', name: 'Exit-Readiness Score', owner: 'computed', cadence: 'computed', layer: 5, direction: 'up_good', unit: 'score', green: null, yellow: null, red: null, targetMin: null, targetMax: null, type: 'computed', manualEntry: false }
];

const BOARD_SPEC_BY_KEY = new Map(SCORECARD_KPIS.map((kpi) => [kpi.key, kpi]));

export const KPIS = KPI_RUNTIME.map((runtime) => {
  const spec = BOARD_SPEC_BY_KEY.get(runtime.key);
  if (!spec) return runtime;
  return {
    ...runtime,
    definition: spec.definition,
    owner: spec.owner,
    cadence: spec.cadence,
    baseline: spec.baseline,
    baselineSource: spec.baseline_source,
    thresholdText: { ...spec.thresholds },
    definitionNote: spec.definition_note,
    verification: spec.verification || null
  };
});

export const WATCH_ITEMS = [
  { key: 'six_month_rule_pilot_hire', name: 'Six-Month Rule — Pilot Hire', type: 'special_watch_item', layer: 2, definition: "founder interventions inside the pilot hire's mapped lane", green: '0', review: 'reviewed at the January 2027 board meeting then retired or renewed' }
];

export function layerByPosition(position) {
  return LAYERS.find((layer) => layer.position === Number(position)) || null;
}
export function kpisForLayer(position) {
  return KPIS.filter((kpi) => kpi.layer === Number(position));
}
export function watchItemsForLayer(position) {
  return WATCH_ITEMS.filter((item) => item.layer === Number(position));
}
