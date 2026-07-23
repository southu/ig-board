import Link from 'next/link';
import { LAYERS, kpisForLayer } from '../lib/catalog';
import { kpiView, worstStatus, STATUS_LABEL } from '../lib/rag';

// The Boardroom hero: the five scorecard layers as stacked bands, apex (layer 1,
// narrowest) to base (layer 5, widest). Layers 1–3 are MANAGE; 4–5 are MONITOR.
// Each band's color is the worst RAG among its KPIs (gray when no KPI has data
// yet — the deliberate empty state with a visible "No data" label). The whole
// band is a link into that layer's detail page.
export default function Pyramid({ valuesByKey }) {
  const manage = LAYERS.filter((l) => l.manage);
  const monitor = LAYERS.filter((l) => !l.manage);

  return (
    <div
      className="pyramid"
      aria-label="Boardroom scorecard pyramid"
      data-testid="scorecard-pyramid"
    >
      <section
        className="pyramid__group pyramid__group--manage"
        data-tier="MANAGE"
        data-testid="pyramid-group-manage"
        aria-labelledby="pyramid-manage-label"
      >
        <h2 id="pyramid-manage-label" className="pyramid__group-label">
          MANAGE
        </h2>
        <div
          className="pyramid__group-bands"
          role="list"
          aria-label="MANAGE layers 1 through 3"
        >
          {manage.map((layer, idx) => (
            <PyramidBand
              key={layer.position}
              layer={layer}
              valuesByKey={valuesByKey}
              widthPct={bandWidth(idx, LAYERS.length)}
              tier="MANAGE"
            />
          ))}
        </div>
      </section>

      <section
        className="pyramid__group pyramid__group--monitor"
        data-tier="MONITOR"
        data-testid="pyramid-group-monitor"
        aria-labelledby="pyramid-monitor-label"
      >
        <h2 id="pyramid-monitor-label" className="pyramid__group-label">
          MONITOR
        </h2>
        <div
          className="pyramid__group-bands"
          role="list"
          aria-label="MONITOR layers 4 through 5"
        >
          {monitor.map((layer, idx) => (
            <PyramidBand
              key={layer.position}
              layer={layer}
              valuesByKey={valuesByKey}
              // Continue the apex→base taper from manage layers (indices 3–4).
              widthPct={bandWidth(manage.length + idx, LAYERS.length)}
              tier="MONITOR"
            />
          ))}
        </div>
      </section>
    </div>
  );
}

function bandWidth(index, total) {
  // Widen from apex to base: layer 1 narrowest, layer 5 (last) widest.
  return 46 + index * ((100 - 46) / (total - 1));
}

function PyramidBand({ layer, valuesByKey, widthPct, tier }) {
  const kpis = kpisForLayer(layer.position).map((k) => kpiView(k, valuesByKey));
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
      <span className="pyramid__number" aria-hidden="true">
        {layer.position}
      </span>
      <span className="pyramid__tier">{tier}</span>
      <span className="pyramid__name">{layer.name}</span>
      <span
        className={`pyramid__status${empty ? ' pyramid__status--empty' : ''}`}
        data-empty={empty ? 'true' : undefined}
      >
        {statusLabel}
      </span>
    </Link>
  );
}
