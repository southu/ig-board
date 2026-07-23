'use client';

import Link from 'next/link';
import { useRole } from '../lib/founder';

// Header nav link to the founder KPI update page. Rendered ONLY when the signed-
// in member resolves as role 'founder' — so a board (or unauthenticated) visitor
// never sees an Update entry point anywhere in the chrome, keeping the board's
// DOM free of any update control (acceptance criterion 5).
export default function FounderNav() {
  const { role } = useRole();
  if (role !== 'founder') return null;
  return (
    <Link className="nav-link" href="/update" data-testid="founder-nav">
      Update KPIs
    </Link>
  );
}
