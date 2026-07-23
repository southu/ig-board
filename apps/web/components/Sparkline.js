'use client';

import { LineChart, Line } from 'recharts';

// A compact 6-period sparkline (Recharts → inline SVG). Stroke/fill use the
// --accent theme token as a live CSS variable reference in the SVG DOM so:
//   1. the rendered mark carries a design-token reference (not a one-off hex),
//   2. light/dark theme toggles recolor the line without a React re-resolve.
// Fallback hex is only for environments that cannot resolve custom properties.
const ACCENT_STROKE = 'var(--accent, #2f4d7a)';

export default function Sparkline({ values, width = 148, height = 40 }) {
  const points = (values || []).slice(-6).map((p, i) => ({
    i,
    value: p.value === null || p.value === undefined ? null : Number(p.value)
  }));

  if (points.length === 0) return null;

  return (
    <div
      className="sparkline"
      aria-hidden="true"
      data-testid="sparkline"
      data-theme-token="--accent"
    >
      <LineChart width={width} height={height} data={points}>
        <Line
          type="monotone"
          dataKey="value"
          stroke={ACCENT_STROKE}
          strokeWidth={2}
          dot={
            points.length === 1
              ? { r: 2, fill: ACCENT_STROKE, stroke: ACCENT_STROKE }
              : false
          }
          isAnimationActive={false}
          connectNulls
        />
      </LineChart>
    </div>
  );
}
