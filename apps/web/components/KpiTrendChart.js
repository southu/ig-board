'use client';

import { useEffect, useState } from 'react';
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceArea,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from 'recharts';
import { useThemeToken } from '../lib/useThemeToken';
import { formatValue } from '../lib/rag';

// Full-history KPI trend with red/yellow/green threshold bands behind the
// history line. Colors come only from theme tokens (light + dark scopes).
// Animation is gated by prefers-reduced-motion.
export default function KpiTrendChart({ kpi, values }) {
  const stroke = useThemeToken('--accent', '#2f4d7a');
  const bandRed = useThemeToken('--threshold-band-red', 'rgba(178,59,52,0.16)');
  const bandYellow = useThemeToken(
    '--threshold-band-yellow',
    'rgba(185,130,15,0.16)'
  );
  const bandGreen = useThemeToken(
    '--threshold-band-green',
    'rgba(44,122,84,0.16)'
  );
  const grid = useThemeToken('--chart-grid', 'rgba(85,97,122,0.22)');
  const axis = useThemeToken('--chart-axis', '#55617a');
  const surface = useThemeToken('--surface-raised', '#ffffff');
  const text = useThemeToken('--text-primary', '#14203a');
  const animate = usePrefersAnimation();

  const points = (values || [])
    .filter((p) => p && p.value !== null && p.value !== undefined)
    .map((p) => ({
      period: p.period,
      value: Number(p.value)
    }));

  if (points.length === 0) {
    return (
      <p className="kpi-trend__empty" data-testid="kpi-trend-empty">
        No history yet for this KPI.
      </p>
    );
  }

  const valuesOnly = points.map((p) => p.value);
  const bands = thresholdBands(kpi, valuesOnly);

  return (
    <div
      className="kpi-trend__chart"
      data-testid="kpi-trend-chart"
      data-animate={animate ? 'true' : 'false'}
    >
      <ResponsiveContainer width="100%" height={280}>
        <LineChart
          data={points}
          margin={{ top: 12, right: 12, left: 4, bottom: 8 }}
        >
          <CartesianGrid stroke={grid} strokeDasharray="3 3" />
          {bands.map((b) => (
            <ReferenceArea
              key={b.key}
              y1={b.y1}
              y2={b.y2}
              fill={
                String(b.key).startsWith('red')
                  ? bandRed
                  : String(b.key).startsWith('yellow')
                    ? bandYellow
                    : bandGreen
              }
              fillOpacity={1}
              strokeOpacity={0}
              ifOverflow="extendDomain"
            />
          ))}
          <XAxis
            dataKey="period"
            tick={{ fill: axis, fontSize: 12 }}
            stroke={axis}
            tickLine={false}
          />
          <YAxis
            tick={{ fill: axis, fontSize: 12 }}
            stroke={axis}
            tickLine={false}
            width={56}
            domain={bands.length ? ['dataMin', 'dataMax'] : ['auto', 'auto']}
            tickFormatter={(v) => formatValue(v, kpi.unit)}
          />
          <Tooltip
            contentStyle={{
              background: surface,
              border: `1px solid ${grid}`,
              borderRadius: 8,
              color: text
            }}
            labelStyle={{ color: text }}
            formatter={(v) => [formatValue(v, kpi.unit), kpi.name]}
          />
          <Line
            type="monotone"
            dataKey="value"
            stroke={stroke}
            strokeWidth={2.5}
            dot={{ r: 3, fill: stroke, stroke }}
            activeDot={{ r: 5 }}
            isAnimationActive={animate}
            connectNulls
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

// Respect prefers-reduced-motion for chart (and theme/band) motion polish.
function usePrefersAnimation() {
  const [animate, setAnimate] = useState(true);
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return undefined;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const apply = () => setAnimate(!mq.matches);
    apply();
    if (mq.addEventListener) mq.addEventListener('change', apply);
    else mq.addListener(apply);
    return () => {
      if (mq.removeEventListener) mq.removeEventListener('change', apply);
      else mq.removeListener(apply);
    };
  }, []);
  return animate;
}

// Build y-band regions from KPI thresholds + direction so the chart paints
// red / yellow / green zones behind the history line.
export function thresholdBands(kpi, values) {
  if (!kpi) return [];
  const nums = (values || []).filter((v) => Number.isFinite(Number(v))).map(Number);
  const thresholds = [kpi.green, kpi.yellow, kpi.red]
    .filter((t) => t !== null && t !== undefined && Number.isFinite(Number(t)))
    .map(Number);

  if (thresholds.length === 0 && kpi.direction !== 'target_band') {
    return [];
  }

  let min = nums.length ? Math.min(...nums) : 0;
  let max = nums.length ? Math.max(...nums) : 1;
  for (const t of thresholds) {
    min = Math.min(min, t);
    max = Math.max(max, t);
  }
  if (kpi.direction === 'target_band') {
    if (kpi.targetMin != null) min = Math.min(min, Number(kpi.targetMin));
    if (kpi.targetMax != null) max = Math.max(max, Number(kpi.targetMax));
  }

  const pad = max === min ? Math.abs(max || 1) * 0.1 || 1 : (max - min) * 0.12;
  const lo = min - pad;
  const hi = max + pad;

  if (kpi.direction === 'target_band') {
    const tMin = Number(kpi.targetMin);
    const tMax = Number(kpi.targetMax);
    if (!Number.isFinite(tMin) || !Number.isFinite(tMax)) return [];
    return [
      { key: 'red-lo', y1: lo, y2: tMin },
      { key: 'green', y1: tMin, y2: tMax },
      { key: 'red-hi', y1: tMax, y2: hi }
    ];
  }

  if (kpi.direction === 'down_good') {
    const g = kpi.green != null ? Number(kpi.green) : null;
    const y = kpi.yellow != null ? Number(kpi.yellow) : null;
    const r = kpi.red != null ? Number(kpi.red) : null;
    const bands = [];
    if (g != null) bands.push({ key: 'green', y1: lo, y2: g });
    const yStart = g != null ? g : lo;
    if (y != null) bands.push({ key: 'yellow', y1: yStart, y2: y });
    const rStart = y != null ? y : g != null ? g : lo;
    if (r != null) bands.push({ key: 'red', y1: rStart, y2: Math.max(r, hi) });
    else if (y != null || g != null) {
      bands.push({ key: 'red', y1: rStart, y2: hi });
    }
    return bands;
  }

  // up_good (default): higher is better — green above green threshold.
  const g = kpi.green != null ? Number(kpi.green) : null;
  const y = kpi.yellow != null ? Number(kpi.yellow) : null;
  const r = kpi.red != null ? Number(kpi.red) : null;
  const bands = [];
  if (g != null) bands.push({ key: 'green', y1: g, y2: hi });
  if (y != null && g != null) bands.push({ key: 'yellow', y1: y, y2: g });
  else if (y != null) bands.push({ key: 'yellow', y1: y, y2: hi });
  const redTop = y != null ? y : g != null ? g : hi;
  if (r != null || y != null || g != null) {
    bands.push({ key: 'red', y1: lo, y2: redTop });
  }
  return bands;
}
