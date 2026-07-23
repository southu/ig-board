'use client';

import Pyramid from './Pyramid';
import { useKpiValues } from '../lib/data';

export default function ScorecardDashboard() {
  // KPI values arrive with the signed-in user's JWT only. Watch items remain
  // separate catalog entries and are never included in the RAG calculation.
  const { valuesByKey } = useKpiValues();

  return (
    <div data-testid="app-shell" data-signed-in="true">
      <p className="eyebrow">Board scorecard</p>
      <h1>The Image Group at a glance</h1>
      <p className="lede">
        The company on one surface — five board-defined layers from leadership
        alignment through enterprise value. Each band takes the color of its worst KPI:
        green on track, amber to watch, red off track, and a calm gray until the
        numbers land.
      </p>

      <Pyramid valuesByKey={valuesByKey} />

      <p className="pyramid__legend">
        The board manages the foundation and monitors the outputs.
      </p>
      <p className="pyramid__hint">Select a layer to open its KPI detail.</p>
    </div>
  );
}
