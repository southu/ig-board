'use client';

import AuthGuard from '../components/AuthGuard';
import Pyramid from '../components/Pyramid';
import { useKpiValues } from '../lib/data';

// Authenticated home: the five-layer Boardroom pyramid. Band color = worst RAG
// in the layer, computed client-side from live KPI values vs. thresholds; gray
// until data exists. Bands link into each layer's detail page.
export default function HomePage() {
  return (
    <AuthGuard>
      <HomeContent />
    </AuthGuard>
  );
}

function HomeContent() {
  // KPI values arrive via GET /api/kpi-values with the signed-in user's JWT only
  // (same-origin API; no service-role key in any client asset). Until values
  // load, bands render the deliberate gray "No data" empty state.
  const { valuesByKey } = useKpiValues();

  return (
    <div data-testid="app-shell" data-signed-in="true">
      <p className="eyebrow">Board scorecard</p>
      <h1>The Image Group at a glance</h1>
      <p className="lede">
        The company on one surface — five board-defined layers from leadership
        alignment through enterprise value. Each band takes the color of its worst KPI:
        green on track, amber to watch, red off track, and a calm gray until the
        numbers land. The board <strong>manages</strong> the top three layers and{' '}
        <strong>monitors</strong> the bottom two.
      </p>

      <Pyramid valuesByKey={valuesByKey} />

      <p className="pyramid__hint">Select a layer to open its KPI detail.</p>
    </div>
  );
}
