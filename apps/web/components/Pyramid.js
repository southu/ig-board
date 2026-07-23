import Link from 'next/link';
import { LAYERS, kpisForLayer } from '../lib/catalog';
import { kpiView, worstStatus, STATUS_LABEL } from '../lib/rag';

// The Boardroom hero: the five scorecard layers as stacked bands, apex (layer 1,
// narrowest) to base (layer 5, widest). Each band's color is the worst RAG among
// its KPIs (gray when no KPI has data yet — the deliberate empty state). The
// whole band is a link into that layer's detail page.
export default function Pyramid({ valuesByKey }) {
  return (
    <div className="pyramid" role="list" aria-label="Boardroom scorecard pyramid">
      {LAYERS.map((layer, idx) => {
        const kpis = kpisForLayer(layer.position).map((k) =>
          kpiView(k, valuesByKey)
        );
        const status = worstStatus(kpis.map((k) => k.status));
        // Widen from apex to base: layer 1 narrowest, layer 5 (last) widest.
        const width = 46 + idx * ((100 - 46) / (LAYERS.length - 1));
        const tier = layer.manage ? 'MANAGE' : 'MONITOR';
        return (
          <Link
            key={layer.position}
            href={`/layer/${layer.position}`}
            role="listitem"
            className={`pyramid__band pyramid__band--${status}`}
            style={{ width: `${width}%` }}
            data-layer={layer.position}
            data-status={status}
            data-tier={tier}
            aria-label={`Layer ${layer.position}: ${layer.name}. ${tier}. Status ${STATUS_LABEL[status]}. Open detail.`}
          >
            <span className="pyramid__tier">{tier}</span>
            <span className="pyramid__name">{layer.name}</span>
            <span className="pyramid__status">{STATUS_LABEL[status]}</span>
          </Link>
        );
      })}
    </div>
  );
}
