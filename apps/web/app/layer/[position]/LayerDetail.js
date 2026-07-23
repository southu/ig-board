'use client';

import Link from 'next/link';
import AuthGuard from '../../../components/AuthGuard';
import RagChip from '../../../components/RagChip';
import Sparkline from '../../../components/Sparkline';
import { useKpiValues } from '../../../lib/data';
import { layerByPosition, kpisForLayer } from '../../../lib/catalog';
import {
  kpiView,
  formatValue,
  targetLabel,
  exitReadiness
} from '../../../lib/rag';

// Layer detail: one KPI card per KPI in the layer — value (or no-data), target,
// 6-period sparkline, RAG chip, owner, last-updated. Layer 5 additionally shows
// a COMPUTED exit-readiness score (no free-entry control for it).
export default function LayerDetail({ position }) {
  return (
    <AuthGuard>
      <DetailContent position={position} />
    </AuthGuard>
  );
}

function DetailContent({ position }) {
  const layer = layerByPosition(position);
  const { valuesByKey } = useKpiValues();

  if (!layer) {
    return (
      <>
        <p className="eyebrow">Layer</p>
        <h1>Unknown layer</h1>
        <p className="lede">That scorecard layer does not exist.</p>
        <p>
          <Link href="/">← Back to the pyramid</Link>
        </p>
      </>
    );
  }

  const tier = layer.manage ? 'MANAGE' : 'MONITOR';
  const kpis = kpisForLayer(layer.position).map((k) => kpiView(k, valuesByKey));

  return (
    <>
      <p className="eyebrow">
        <Link href="/">Pyramid</Link> · Layer {layer.position} · {tier}
      </p>
      <h1>{layer.name}</h1>
      <p className="lede">{layer.description}</p>

      {layer.position === 5 && <ExitReadiness kpis={kpis} />}

      <section className="kpi-grid" aria-label={`${layer.name} KPIs`}>
        {kpis.map((k) => (
          <KpiCard key={k.key} kpi={k} />
        ))}
      </section>
    </>
  );
}

function KpiCard({ kpi }) {
  const hasData = kpi.status !== 'none' && kpi.latest;
  const value = hasData ? formatValue(kpi.latest.value, kpi.unit) : 'No data';

  return (
    <article className={`kpi-card kpi-card--${kpi.status}`} data-kpi={kpi.key}>
      <header className="kpi-card__head">
        <h2 className="kpi-card__name">{kpi.name}</h2>
        <RagChip status={kpi.status} />
      </header>

      <p className={`kpi-card__value${hasData ? '' : ' kpi-card__value--empty'}`}>
        {value}
      </p>

      {kpi.values.length > 0 ? (
        <Sparkline values={kpi.values} />
      ) : (
        <div className="sparkline sparkline--empty" aria-hidden="true">
          Awaiting readings
        </div>
      )}

      <dl className="kpi-card__meta">
        <div>
          <dt>Target</dt>
          <dd>{targetLabel(kpi)}</dd>
        </div>
        <div>
          <dt>Owner</dt>
          <dd>{kpi.owner}</dd>
        </div>
        <div>
          <dt>Last updated</dt>
          <dd>{hasData ? kpi.latest.period : '—'}</dd>
        </div>
      </dl>
    </article>
  );
}

// Computed exit-readiness for layer 5 — derived from the People & Organization
// KPI statuses, never free-entered. Rendered as read-only output.
function ExitReadiness({ kpis }) {
  const score = exitReadiness(kpis);
  const computed = score !== null;

  return (
    <section
      className="exit-readiness"
      aria-label="Exit readiness (computed)"
      data-computed={computed ? 'true' : 'false'}
    >
      <div className="exit-readiness__head">
        <p className="eyebrow">Exit readiness · computed</p>
        <p className="exit-readiness__note">
          A read-only roll-up of the layer&rsquo;s KPI health — the board&rsquo;s
          proxy for organizational durability and founder-independence. Derived
          from the KPIs below; there is no manual entry for this score.
        </p>
      </div>
      <div className="exit-readiness__score" data-score={computed ? score : ''}>
        {computed ? (
          <>
            <span className="exit-readiness__number">{score}</span>
            <span className="exit-readiness__scale">/ 100</span>
          </>
        ) : (
          <span className="exit-readiness__number exit-readiness__number--empty">
            Awaiting data
          </span>
        )}
      </div>
    </section>
  );
}
