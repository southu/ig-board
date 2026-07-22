// Server-only Supabase admin client for privileged (service-role) operations.
//
// Reads SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY from process.env ONLY. The
// service-role key bypasses Row Level Security, so it MUST NEVER be sent to a
// browser, committed, or logged. The public anon key (SUPABASE_ANON_KEY) is for
// client-side use only and is intentionally NOT read here.
//
// Dependency-free: uses Node's built-in global fetch (Node >= 18) so the Railway
// build has no extra lockfile / native-module surface to break.

// Resolve the admin config from the server environment. Throws (fail closed)
// when either value is missing, so a misconfigured deploy never silently runs
// admin ops against the wrong project or with no auth.
export function adminConfig() {
  const url = (process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
  const serviceRoleKey = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  if (!url) {
    const err = new Error('SUPABASE_URL is not set');
    err.code = 'ADMIN_NOT_CONFIGURED';
    throw err;
  }
  if (!serviceRoleKey) {
    const err = new Error('SUPABASE_SERVICE_ROLE_KEY is not set');
    err.code = 'ADMIN_NOT_CONFIGURED';
    throw err;
  }
  return { url, serviceRoleKey };
}

// True when both SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are present. Never
// throws — use it to branch before attempting admin ops.
export function isAdminConfigured() {
  try {
    adminConfig();
    return true;
  } catch {
    return false;
  }
}

// Perform an authenticated request against the Supabase project using the
// service-role key. `path` is appended to SUPABASE_URL (e.g. '/rest/v1/users').
// Returns the raw fetch Response; callers decide how to read it.
export async function adminFetch(path, opts = {}) {
  const { url, serviceRoleKey } = adminConfig();
  const headers = {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
    ...(opts.headers || {}),
  };
  return fetch(`${url}${path}`, { ...opts, headers });
}

// Lightweight reachability + auth check for admin ops. Hits the Auth Admin API
// (a service-role-only endpoint) and resolves to { ok, status }. Never throws on
// an HTTP error — only on a missing config or a transport failure. Intended for
// operator scripts / a manual smoke test, NOT for the request hot path or boot.
export async function pingAdmin() {
  const res = await adminFetch('/auth/v1/admin/users?page=1&per_page=1', {
    method: 'GET',
  });
  return { ok: res.ok, status: res.status };
}
