'use client';

import Link from 'next/link';
import AuthGuard from '../../../components/AuthGuard';
import RagChip from '../../../components/RagChip';
import KpiTrendChart from '../../../components/KpiTrendChart';
import CommentThread from '../../../components/CommentThread';
import { useKpiValues } from '../../../lib/data';
import { KPIS } from '../../../lib/catalog';
import {
  kpiView,
  formatValue,
  targetLabel,
  STATUS_LABEL
} from '../../../lib/rag';

// Per-KPI trend page: full history line with red/yellow/green threshold bands
// (Recharts + theme tokens, both themes). Linked from layer detail KPI cards.
export default function KpiTrendPage({ kpiKey }) {
  return (
    <AuthGuard>
      <TrendContent kpiKey={kpiKey} />
    </AuthGuard>
  );
}

function TrendContent({ kpiKey }) {
  const { valuesByKey } = useKpiValues();
  const catalog = KPIS.find((k) => k.key === kpiKey);

  if (!catalog) {
    return (
      <>
        <p className="eyebrow">KPI trend</p>
        <h1>Unknown KPI</h1>
        <p className="lede">That scorecard KPI does not exist.</p>
        <p>
          <Link href="/">← Back to the pyramid</Link>
        </p>
      </>
    );
  }

  const kpi = kpiView(catalog, valuesByKey);
  const hasData = kpi.status !== 'none' && kpi.latest;
  const value = hasData ? formatValue(kpi.latest.value, kpi.unit) : 'No data';

  return (
    <article className="kpi-trend" data-testid="kpi-trend" data-kpi={kpi.key}>
      <p className="eyebrow">
        <Link href="/">Pyramid</Link>
        {' · '}
        <Link href={`/layer/${kpi.layer}`}>Layer {kpi.layer}</Link>
        {' · '}
        Trend
      </p>
      <header className="kpi-card__head">
        <h1>{kpi.name}</h1>
        <RagChip status={kpi.status} />
      </header>
      <p className="lede">
        History with red / yellow / green threshold bands. Status is{' '}
        <strong>{STATUS_LABEL[kpi.status]}</strong>
        {hasData ? ` · latest ${value} (${kpi.latest.period})` : ''}. Target:{' '}
        {targetLabel(kpi)}. Owner: {kpi.owner}.
      </p>

      <section className="panel" aria-label={`${kpi.name} history chart`}>
        <h2 className="visually-hidden">History chart</h2>
        <KpiTrendChart kpi={kpi} values={kpi.values} />
        <ul className="kpi-trend__legend" aria-label="Threshold bands">
          <li>
            <span className="kpi-trend__swatch kpi-trend__swatch--green" />
            Green — on track
          </li>
          <li>
            <span className="kpi-trend__swatch kpi-trend__swatch--yellow" />
            Yellow — watch
          </li>
          <li>
            <span className="kpi-trend__swatch kpi-trend__swatch--red" />
            Red — off track
          </li>
        </ul>
      </section>

      <CommentThread
        target={{ kpi_id: kpi.key }}
        title={`Discussion · ${kpi.name}`}
      />
    </article>
  );
}
