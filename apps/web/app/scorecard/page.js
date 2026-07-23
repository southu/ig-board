'use client';

import AuthGuard from '../../components/AuthGuard';
import ScorecardDashboard from '../../components/ScorecardDashboard';

export default function ScorecardPage() {
  return (
    <AuthGuard>
      <ScorecardDashboard />
    </AuthGuard>
  );
}
