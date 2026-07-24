'use client';

import Link from 'next/link';
import { useRole } from '../lib/founder';

// Header link to the admin area. Rendered only when the signed-in member has
// the access_admin_area capability so non-admins never see an Admin entry point.
export default function AdminNav() {
  const { capabilities, loading } = useRole();
  if (loading) return null;
  if (!Array.isArray(capabilities) || !capabilities.includes('access_admin_area')) {
    return null;
  }
  return (
    <Link className="nav-link" href="/admin" data-testid="admin-nav">
      Admin
    </Link>
  );
}
