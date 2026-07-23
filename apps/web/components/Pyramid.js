import Link from 'next/link';
import { LAYERS, kpisForLayer, watchItemsForLayer } from '../lib/catalog';
import { kpiView, worstStatus, STATUS_LABEL } from '../lib/rag';

// The Boardroom hero: layer 1 sits at the narrow apex and layer 5 at the wide
// foundation. Layers 1–3 are MANAGE; 4–5 are MONITOR.
// Each band's color is the worst RAG among its KPIs (gray when no KPI has data
// yet — the deliberate empty state with a visible "No data" label). The whole
// band is a link into that layer's detail page.
export default function Pyramid({ valuesByKey }) {
  const topToBottom = [...LAYERS].sort((a, b) => a.position - b.position);

  return (
    <div
      className="pyramid"
      aria-label="Boardroom scorecard pyramid"
      data-testid="scorecard-pyramid"
      role="list"
    >
      {topToBottom.map((layer) => (
        <PyramidBand
          key={layer.position}
          layer={layer}
          valuesByKey={valuesByKey}
          widthPct={bandWidth(layer.position)}
          tier={layer.manage ? 'MANAGE' : 'MONITOR'}
        />
      ))}
    </div>
  );
}

function bandWidth(position) {
  // Layer 1 is the narrow apex; every successive layer is twelve points wider.
  return 40 + position * 12;
}

function PyramidBand({ layer, valuesByKey, widthPct, tier }) {
  const kpis = kpisForLayer(layer.position).map((k) => kpiView(k, valuesByKey));
  const watchItems = watchItemsForLayer(layer.position);
  // Intentionally KPI-only: a time-boxed watch item never affects band color.
  const status = worstStatus(kpis.map((k) => k.status));
  const empty = status === 'none';
  const statusLabel = empty ? 'No data' : STATUS_LABEL[status];

  return (
    <Link
      href={`/layer/${layer.position}`}
      role="listitem"
      className={`pyramid__band pyramid__band--${status}${empty ? ' pyramid__band--empty' : ''}`}
      style={{ width: `${widthPct}%` }}
      data-layer={layer.position}
      data-status={status}
      data-tier={tier}
      data-testid={`pyramid-layer-${layer.position}`}
      aria-label={`Layer ${layer.position}: ${layer.name}. ${tier}. Status ${statusLabel}. Open detail.`}
    >
      <span className="pyramid__heading">
        <span className="pyramid__number">Layer {layer.position}</span>
        <span className="pyramid__tier">{tier}</span>
        <span
          className={`pyramid__status${empty ? ' pyramid__status--empty' : ''}`}
          data-empty={empty ? 'true' : undefined}
        >
          {statusLabel}
        </span>
      </span>
      <span className="pyramid__name">{layer.name}</span>
      <span className="pyramid__subtitle">“{layer.description}”</span>
      <span className="pyramid__kpis" aria-label={`Layer ${layer.position} KPIs`}>
        {kpis.map((kpi) => (
          <span
            key={kpi.key}
            className={`pyramid__kpi pyramid__kpi--${kpi.status}`}
            data-kpi={kpi.key}
            data-status={kpi.status}
          >
            <span>{kpi.name}</span>
            <span>{STATUS_LABEL[kpi.status]}</span>
          </span>
        ))}
      </span>
      {watchItems.map((item) => (
        <span
          key={item.key}
          className="pyramid__watch-item"
          data-watch-item={item.key}
          data-excluded-from-status="true"
        >
          <span className="pyramid__watch-badge">TIME-BOXED WATCH ITEM</span>
          <span className="pyramid__watch-name">{item.name}</span>
          <span className="pyramid__watch-review">{item.review}</span>
        </span>
      ))}
    </Link>
  );
}
