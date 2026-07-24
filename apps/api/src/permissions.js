// Authoritative role → capability map for Boardroom.
//
// Every server-side permission check must derive from this module. Do not
// scatter role allowlists across routes — import hasCapability / require helpers
// instead. Legacy founder|board JWT roles are aliases of admin|board_member so
// existing sessions and tests keep working while governance roles are canonical.

export const CAPABILITIES = Object.freeze([
  'input_kpi_data',
  'edit_kpi_data',
  'delete_any_comment',
  'access_admin_area'
]);

/** @type {Readonly<Record<string, readonly string[]>>} */
export const PERMISSIONS = Object.freeze({
  admin: Object.freeze([
    'input_kpi_data',
    'edit_kpi_data',
    'delete_any_comment',
    'access_admin_area'
  ]),
  executive: Object.freeze(['input_kpi_data', 'edit_kpi_data']),
  employee: Object.freeze(['input_kpi_data']),
  consultant: Object.freeze(['input_kpi_data']),
  board_member: Object.freeze([]),
  // Legacy aliases (JWT app_metadata.role from older seeds / tests)
  founder: Object.freeze([
    'input_kpi_data',
    'edit_kpi_data',
    'delete_any_comment',
    'access_admin_area'
  ]),
  board: Object.freeze([])
});

/** Roles recognized by the permissions system (governance + legacy). */
export const APP_ROLES = Object.freeze(Object.keys(PERMISSIONS));

/** Canonical five governance roles (excludes legacy aliases). */
export const GOVERNANCE_ROLES = Object.freeze([
  'admin',
  'executive',
  'board_member',
  'employee',
  'consultant'
]);

// Map legacy JWT roles onto governance names for client exposure.
export function canonicalRole(role) {
  if (role === 'founder') return 'admin';
  if (role === 'board') return 'board_member';
  if (typeof role === 'string' && GOVERNANCE_ROLES.includes(role)) return role;
  return role || null;
}

// Resolve the capability list for a role. Unknown / null → empty (deny by default).
export function capabilitiesForRole(role) {
  if (!role || typeof role !== 'string') return [];
  const caps = PERMISSIONS[role];
  return caps ? [...caps] : [];
}

// True when the role includes the named capability.
export function hasCapability(role, capability) {
  if (!capability || typeof capability !== 'string') return false;
  const caps = PERMISSIONS[role];
  if (!caps) return false;
  return caps.includes(capability);
}

// Board-audience CSV export: anyone without access_admin_area (admin/founder use
// in-app audit). Unknown roles denied.
export function canExportKpiCsv(role) {
  if (!role || !Object.prototype.hasOwnProperty.call(PERMISSIONS, role)) {
    return false;
  }
  return !hasCapability(role, 'access_admin_area');
}

// Session payload shape shared by GET /me and GET /api/session.
export function sessionPayload({ userId = null, role = null, email = null } = {}) {
  const rawRole = role || null;
  const exposedRole = canonicalRole(rawRole);
  return {
    id: userId ?? null,
    role: exposedRole,
    email: email ?? null,
    capabilities: capabilitiesForRole(rawRole || exposedRole)
  };
}
