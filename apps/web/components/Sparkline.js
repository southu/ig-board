'use client';

import { LineChart, Line } from 'recharts';
import { useThemeToken } from '../lib/useThemeToken';

// A compact 6-period sparkline (Recharts -> inline SVG). The stroke is resolved
// from the --accent theme token via useThemeToken, so toggling light/dark
// re-colors the line through the design tokens (no hard-coded color here).
export default function Sparkline({ values, width = 148, height = 40 }) {
  const stroke = useThemeToken('--accent', '#2f4d7a');
  const points = (values || []).slice(-6).map((p, i) => ({
    i,
    value: p.value === null || p.value === undefined ? null : Number(p.value)
  }));

  if (points.length === 0) return null;

  return (
    <div className="sparkline" aria-hidden="true">
      <LineChart width={width} height={height} data={points}>
        <Line
          type="monotone"
          dataKey="value"
          stroke={stroke}
          strokeWidth={2}
          dot={points.length === 1 ? { r: 2, fill: stroke, stroke } : false}
          isAnimationActive={false}
          connectNulls
        />
      </LineChart>
    </div>
  );
}
