// Board-role CSV serialization of all kpi_values.
//
// Wire shape matches the scorecard time-series map used by GET /api/kpi-values:
//   { <kpiKey>: [{ period, value }, ...] }
// Emitted columns: kpi_key,period,value  (header + one row per observation).
// Pure: no I/O, no secrets.

function csvEscape(cell) {
  const s = cell == null ? '' : String(cell);
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

// Build a text/csv body (LF newlines) for the given values map. Empty map still
// emits the header so consumers always get a well-formed CSV.
export function kpiValuesToCsv(valuesByKey) {
  const lines = ['kpi_key,period,value'];
  const map = valuesByKey && typeof valuesByKey === 'object' ? valuesByKey : {};
  const keys = Object.keys(map).sort();
  for (const key of keys) {
    const series = map[key];
    if (!Array.isArray(series)) continue;
    const ordered = series
      .slice()
      .sort((a, b) => String(a.period).localeCompare(String(b.period)));
    for (const point of ordered) {
      const period = point && point.period != null ? point.period : '';
      const value =
        point && point.value !== undefined && point.value !== null
          ? point.value
          : '';
      lines.push(
        [csvEscape(key), csvEscape(period), csvEscape(value)].join(',')
      );
    }
  }
  return lines.join('\n') + '\n';
}
