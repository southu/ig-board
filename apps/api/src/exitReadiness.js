export const EXIT_READINESS_KEY = 'exit_readiness_score';

export const EXIT_READINESS_NOTE =
  "The spread between this company's bear-case and bull-case valuation is roughly $8–10M. These four conditions are that spread.";

const CONDITION_DEFINITIONS = [
  {
    key: 'concentration_cap',
    name: 'Concentration cap',
    detail: 'KPI 4.3 Customer Concentration is green'
  },
  {
    key: 'founder_independence',
    name: 'Founder independence',
    detail: 'KPIs 3.1 Time to First Revenue and 3.2 Founder Intervention Count are both green'
  },
  {
    key: 'core_profitability',
    name: 'Core profitability',
    detail: 'KPI 4.2 Core Net Ordinary Income is green'
  },
  {
    key: 'adjusted_ebitda_trend',
    name: 'Adjusted EBITDA trend positive',
    detail: 'KPI 5.1 Adjusted EBITDA (TTM) recorded history has a positive trend'
  }
];

function numericSeries(valuesByKey, key) {
  return ((valuesByKey && valuesByKey[key]) || [])
    .map((point) => ({
      period: String(point.period || ''),
      value: Number(point.value)
    }))
    .filter((point) => point.period && Number.isFinite(point.value))
    .sort((a, b) => a.period.localeCompare(b.period));
}

function latestValue(valuesByKey, key) {
  const series = numericSeries(valuesByKey, key);
  return series.length ? series[series.length - 1].value : null;
}

// Least-squares slope across all recorded observations. Requiring two readings
// keeps a single point from being called a trend; a positive slope is positive
// even when the history contains temporary dips.
function hasPositiveTrend(series) {
  if (series.length < 2) return false;
  const xMean = (series.length - 1) / 2;
  const yMean = series.reduce((sum, point) => sum + point.value, 0) / series.length;
  let numerator = 0;
  let denominator = 0;
  for (let i = 0; i < series.length; i += 1) {
    numerator += (i - xMean) * (series[i].value - yMean);
    denominator += (i - xMean) ** 2;
  }
  return denominator > 0 && numerator / denominator > 0;
}

export function computeExitReadiness(valuesByKey) {
  const concentration = latestValue(valuesByKey, 'customer_concentration');
  const timeToRevenue = latestValue(valuesByKey, 'time_to_first_revenue');
  const interventions = latestValue(valuesByKey, 'founder_intervention_count');
  const coreNoi = latestValue(valuesByKey, 'core_net_ordinary_income');
  const ebitda = numericSeries(valuesByKey, 'adjusted_ebitda_ttm');

  const metByKey = {
    concentration_cap: concentration !== null && concentration <= 20,
    founder_independence:
      timeToRevenue !== null &&
      timeToRevenue <= 6 &&
      interventions !== null &&
      interventions <= 0,
    core_profitability: coreNoi !== null && coreNoi >= 1000000,
    adjusted_ebitda_trend: hasPositiveTrend(ebitda)
  };
  const conditions = CONDITION_DEFINITIONS.map((condition) => ({
    ...condition,
    met: metByKey[condition.key]
  }));
  const score = conditions.filter((condition) => condition.met).length;
  const periods = [
    ...numericSeries(valuesByKey, 'customer_concentration'),
    ...numericSeries(valuesByKey, 'time_to_first_revenue'),
    ...numericSeries(valuesByKey, 'founder_intervention_count'),
    ...numericSeries(valuesByKey, 'core_net_ordinary_income'),
    ...ebitda
  ].map((point) => point.period);

  return {
    period: periods.sort().at(-1) || new Date().toISOString().slice(0, 10),
    value: `${score} of 4 conditions met`,
    display_value: `${score} of 4 conditions met`,
    score,
    count: score,
    total: 4,
    status: score === 4 ? 'green' : score >= 2 ? 'yellow' : 'red',
    computed: true,
    conditions,
    definition_note: EXIT_READINESS_NOTE
  };
}

// Never trust or expose a stored/manual 5.2 history. Its sole observation is
// reconstructed from the current underlying histories on every read.
export function withExitReadiness(valuesByKey) {
  const values = { ...(valuesByKey || {}) };
  delete values[EXIT_READINESS_KEY];
  const exitReadiness = computeExitReadiness(values);
  values[EXIT_READINESS_KEY] = [exitReadiness];
  return { values, exitReadiness };
}
