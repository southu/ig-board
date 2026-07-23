// Client-side RAG (red/amber/green) computation — the mission's source of truth
// for band + chip color. Status is derived from the latest observed value vs.
// the KPI's thresholds and direction; a KPI with no value is 'none' (the
// deliberate gray no-data state), never silently green.

export const STATUSES = ['green', 'yellow', 'red', 'none'];

// Worst-first severity so a layer band takes the color of its worst KPI.
const SEVERITY = { red: 3, yellow: 2, green: 1, none: 0 };

export const STATUS_LABEL = {
  green: 'On track',
  yellow: 'Watch',
  red: 'Off track',
  none: 'No data'
};

// Compute the RAG status for one KPI from a numeric value. Returns 'none' when
// there is no value to judge. Threshold tiers are ordered best→worst; a null
// tier collapses (so a single-threshold KPI still resolves sensibly).
export function computeStatus(value, kpi) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return 'none';
  }
  const v = Number(value);
  const { direction, green, yellow, red, targetMin, targetMax } = kpi;

  if (direction === 'target_band') {
    const min = targetMin;
    const max = targetMax;
    if (min !== null && max !== null && v >= min && v <= max) return 'green';
    return 'red';
  }

  if (direction === 'down_good') {
    if (green !== null && v <= green) return 'green';
    if (yellow !== null && v <= yellow) return 'yellow';
    if (red !== null && v <= red) return 'red';
    // Below all defined "good" ceilings -> worst tier present, else amber.
    return red !== null || yellow !== null ? 'red' : 'yellow';
  }

  // Default: up_good (higher is better).
  if (green !== null && v >= green) return 'green';
  if (yellow !== null && v >= yellow) return 'yellow';
  if (red !== null && v >= red) return 'red';
  return red !== null || yellow !== null ? 'red' : 'yellow';
}

// The worst status across a set (used for a layer band). 'none' only wins when
// every KPI is 'none' (no data at all) — any real reading makes the band
// non-gray, taking the worst real color.
export function worstStatus(statuses) {
  const real = statuses.filter((s) => s && s !== 'none');
  if (real.length === 0) return 'none';
  return real.reduce((worst, s) => (SEVERITY[s] > SEVERITY[worst] ? s : worst));
}

// The latest (last, since values arrive period-ascending) observed point.
export function latestPoint(values) {
  if (!Array.isArray(values) || values.length === 0) return null;
  return values[values.length - 1];
}

// Merge the static catalog KPI with its observed values into a view model:
// { ...kpi, values, latest, status }.
export function kpiView(kpi, valuesByKey) {
  const values = (valuesByKey && valuesByKey[kpi.key]) || [];
  const latest = latestPoint(values);
  const status =
    kpi.type === 'computed' && latest && STATUSES.includes(latest.status)
      ? latest.status
      : computeStatus(latest ? latest.value : null, kpi);
  return { ...kpi, values, latest, status };
}

// A human-readable target string from the KPI thresholds/direction.
export function targetLabel(kpi) {
  const { direction, green, targetMin, targetMax, unit } = kpi;
  if (direction === 'target_band' && targetMin !== null && targetMax !== null) {
    return `${formatValue(targetMin, unit)}–${formatValue(targetMax, unit)}`;
  }
  if (green === null || green === undefined) return '—';
  const cmp = direction === 'down_good' ? '≤' : '≥';
  return `${cmp} ${formatValue(green, unit)}`;
}

// Compact value formatting that keeps the unit legible (USD -> $, % suffix, …).
export function formatValue(value, unit) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return '—';
  }
  const v = Number(value);
  if (unit === 'USD') {
    if (Math.abs(v) >= 1000000) return `$${trim(v / 1000000)}M`;
    if (Math.abs(v) >= 1000) return `$${trim(v / 1000)}k`;
    return `$${trim(v)}`;
  }
  if (unit === '%') return `${trim(v)}%`;
  if (unit === 'x') return `${trim(v)}x`;
  return `${trim(v)}${unit && unit.length <= 8 ? ` ${unit}` : ''}`;
}

function trim(n) {
  // Up to two decimals, no trailing zeros.
  return Number(n.toFixed(2)).toString();
}
