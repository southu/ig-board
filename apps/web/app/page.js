'use client';

import AuthGuard from '../components/AuthGuard';
import ScorecardDashboard from '../components/ScorecardDashboard';

// Authenticated home: the five-layer Boardroom pyramid. Band color = worst RAG
// in the layer, computed client-side from live KPI values vs. thresholds; gray
// until data exists. Bands link into each layer's detail page.
export default function HomePage() {
  return (
    <AuthGuard>
      <ScorecardDashboard />
    </AuthGuard>
  );
}
