'use client';

import Link from 'next/link';
import AuthGuard from '../../../components/AuthGuard';
import RagChip from '../../../components/RagChip';
import Sparkline from '../../../components/Sparkline';
import CommentThread from '../../../components/CommentThread';
import { useKpiValues } from '../../../lib/data';
import { useDefinitions } from '../../../lib/founder';
import {
  layerByPosition,
  kpisForLayer,
  watchItemsForLayer
} from '../../../lib/catalog';
import {
  kpiView,
  formatValue,
  targetLabel
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
  const { definitions } = useDefinitions();

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

      {watchItemsForLayer(layer.position).map((item) => (
        <section
          className="panel"
          key={item.key}
          data-type={item.type}
          data-testid="special-watch-item"
        >
          <p className="eyebrow">Special watch item · time-boxed</p>
          <h2>{item.name}</h2>
          <p>{item.definition}</p>
          <p><strong>Green:</strong> {item.green}</p>
          <p>{item.review}</p>
        </section>
      ))}

      <section className="kpi-grid" aria-label={`${layer.name} KPIs`}>
        {kpis.map((k) => (
          <KpiCard key={k.key} kpi={k} definition={definitions[k.key]} />
        ))}
      </section>
    </>
  );
}

function KpiCard({ kpi, definition }) {
  const hasData = kpi.status !== 'none' && kpi.latest;
  const value = hasData ? formatValue(kpi.latest.value, kpi.unit) : 'No data';
  // The "definition changed" flag shows only while the last edit is within the
  // 90-day window — the API returns `changed` already reduced to that boolean,
  // so a KPI whose definition changed more than 90 days ago shows no flag.
  const changed = Boolean(definition && definition.changed);
  const changedOn = changed ? shortDate(definition.definition_changed_at) : '';

  return (
    <article
      className={`kpi-card kpi-card--${kpi.status}`}
      data-kpi={kpi.key}
      data-rag={kpi.status}
      data-testid="kpi-card"
      data-definition-changed={changed ? 'true' : 'false'}
    >
      <header className="kpi-card__head">
        <h2 className="kpi-card__name" data-testid="kpi-name">
          {kpi.name}
        </h2>
        <RagChip status={kpi.status} />
      </header>

      {changed ? (
        <p className="kpi-card__flag" data-testid="definition-changed-flag">
          Definition changed{changedOn ? ` ${changedOn}` : ''}
        </p>
      ) : null}

      <p
        className={`kpi-card__value${hasData ? '' : ' kpi-card__value--empty'}`}
        data-testid="kpi-value"
        data-empty={hasData ? 'false' : 'true'}
      >
        {value}
      </p>

      {kpi.values.length > 0 ? (
        <Sparkline values={kpi.values} />
      ) : (
        <div
          className="sparkline sparkline--empty"
          aria-hidden="true"
          data-testid="sparkline-empty"
        >
          Awaiting readings
        </div>
      )}

      <dl className="kpi-card__meta">
        <div>
          <dt>Target</dt>
          <dd data-testid="kpi-target">{targetLabel(kpi)}</dd>
        </div>
        <div>
          <dt>Owner</dt>
          <dd data-testid="kpi-owner">{kpi.owner}</dd>
        </div>
        <div>
          <dt>Last updated</dt>
          <dd data-testid="kpi-last-updated">
            {hasData ? kpi.latest.period : '—'}
          </dd>
        </div>
      </dl>

      <Link
        className="kpi-card__link"
        href={`/kpi/${kpi.key}`}
        data-testid="kpi-trend-link"
      >
        View history &amp; thresholds →
      </Link>

      <CommentThread
        target={{ kpi_id: kpi.key }}
        title={`Discussion · ${kpi.name}`}
      />
    </article>
  );
}

// Format an ISO timestamp as a short YYYY-MM-DD date for the definition-changed
// flag. Falls back to the raw string if it can't be parsed.
function shortDate(iso) {
  if (!iso) return '';
  const s = String(iso);
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : s;
}
