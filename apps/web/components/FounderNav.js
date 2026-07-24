'use client';

import Link from 'next/link';
import { useRole } from '../lib/founder';

// Header nav link to the KPI update page. Visibility is derived from the same
// capability list GET /me exposes (from apps/api/src/permissions.js) — never a
// hard-coded role allowlist. board_member has neither input_kpi_data nor
// edit_kpi_data, so this link is never in their DOM.
export default function FounderNav() {
  const { capabilities, loading } = useRole();
  if (loading) return null;
  const canManage =
    Array.isArray(capabilities) &&
    (capabilities.includes('input_kpi_data') ||
      capabilities.includes('edit_kpi_data'));
  if (!canManage) return null;
  return (
    <Link className="nav-link" href="/update" data-testid="founder-nav">
      Update KPIs
    </Link>
  );
}
