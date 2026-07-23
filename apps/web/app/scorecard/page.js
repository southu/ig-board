'use client';

import AuthGuard from '../../components/AuthGuard';

// A second protected route (beyond /) so the guard is proven on more than the
// home page. Unauthenticated visitors are redirected to /login.
export default function ScorecardPage() {
  return (
    <AuthGuard>
      <p className="eyebrow">Detail</p>
      <h1>Scorecard drilldown</h1>
      <p className="lede">
        KPI history, targets and board commentary land here in a later mission.
        This route exists now to anchor the authenticated navigation surface.
      </p>
      <div className="panel">
        <p>Signed in — protected content is visible.</p>
      </div>
    </AuthGuard>
  );
}
