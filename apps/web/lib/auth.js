// Client-side auth helpers for the invite-only Boardroom app.
//
// There is no self-signup: users are admin-created in Supabase and receive a
// magic link. This module never handles passwords.
//
// Supabase public config (project URL + anon key) is fetched at RUNTIME from the
// same-origin GET /config endpoint rather than inlined from NEXT_PUBLIC_* env.
// The web app ships as a committed static export (no `next build` on deploy —
// see DEPLOY.md), so build-time env inlining can never reach the live bundle;
// the server sources the browser-safe config from its runtime environment
// instead. The anon key is public (RLS is the real guard). When config is
// missing the caller fails closed with a visible error — never a silent no-op.

const SESSION_KEY = 'ig-board.session';

// Cached fetch of the public Supabase config. Resolves to { url, anonKey } with
// url trailing-slash-stripped; both are '' when unconfigured or unreachable. The
// promise is memoized so repeated calls (login submit, theme persistence) issue
// a single request per page load.
let _configPromise = null;
export function loadPublicConfig() {
  if (typeof window === 'undefined') return Promise.resolve({ url: '', anonKey: '' });
  if (_configPromise) return _configPromise;
  _configPromise = fetch('/config', { cache: 'no-store' })
    .then((res) => (res.ok ? res.json() : null))
    .then((body) => ({
      url: ((body && body.supabaseUrl) || '').replace(/\/+$/, ''),
      anonKey: (body && body.supabaseAnonKey) || ''
    }))
    .catch(() => ({ url: '', anonKey: '' }));
  return _configPromise;
}

// Return the stored session ({ access_token, ... }) if present and unexpired,
// else null. Safe to call on the server (returns null).
export function getSession() {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const session = JSON.parse(raw);
    if (!session || !session.access_token) return null;
    if (session.expires_at && session.expires_at * 1000 <= Date.now()) {
      window.localStorage.removeItem(SESSION_KEY);
      return null;
    }
    return session;
  } catch {
    return null;
  }
}

// Supabase magic links return the session in the URL fragment on redirect back
// to the app. Capture it into localStorage and scrub the hash so tokens do not
// linger in the address bar / history.
export function captureCallbackSession() {
  if (typeof window === 'undefined') return;
  const hash = window.location.hash || '';
  if (hash.indexOf('access_token=') === -1) return;
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  const accessToken = params.get('access_token');
  if (!accessToken) return;
  const expiresIn = Number(params.get('expires_in')) || 3600;
  const session = {
    access_token: accessToken,
    refresh_token: params.get('refresh_token') || null,
    expires_at:
      Number(params.get('expires_at')) || Math.floor(Date.now() / 1000) + expiresIn
  };
  try {
    window.localStorage.setItem(SESSION_KEY, JSON.stringify(session));
    window.history.replaceState(null, '', window.location.pathname);
  } catch {
    /* ignore storage failures */
  }
}

export function clearSession() {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(SESSION_KEY);
  } catch {
    /* ignore */
  }
}

// Thrown when the magic-link request cannot be issued because the public
// Supabase config is missing. The login page catches this to fail closed with a
// visible error instead of a false-success confirmation.
export class SupabaseUnconfiguredError extends Error {
  constructor() {
    super('Supabase is not configured');
    this.name = 'SupabaseUnconfiguredError';
  }
}

// Request a magic link for an admin-provisioned user. `create_user: false`
// enforces invite-only — Supabase will not create an account for an unknown
// email. Throws SupabaseUnconfiguredError when the runtime config is missing so
// the UI can fail closed; the actual OTP call is fire-if-configured only.
export async function requestMagicLink(email) {
  const { url, anonKey } = await loadPublicConfig();
  if (!url || !anonKey) throw new SupabaseUnconfiguredError();
  const redirectTo =
    typeof window !== 'undefined' ? window.location.origin + '/' : undefined;
  const res = await fetch(`${url}/auth/v1/otp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: anonKey
    },
    body: JSON.stringify({
      email,
      create_user: false,
      gotrue_meta_security: {},
      ...(redirectTo ? { options: { email_redirect_to: redirectTo } } : {})
    })
  });
  // Invite-only: a 4xx for an unknown/blocked email is expected and must not
  // leak which addresses are provisioned, so a completed request is a success
  // regardless of status. A transport failure (thrown fetch) still propagates.
  return res;
}

// Best-effort persistence of the chosen theme onto the user's Supabase profile
// (user_metadata). Silently no-ops when unconfigured or unauthenticated so the
// theme toggle never blocks or errors on localStorage-only sessions.
export async function persistThemeToProfile(theme) {
  const session = getSession();
  if (!session) return;
  try {
    const { url, anonKey } = await loadPublicConfig();
    if (!url || !anonKey) return;
    await fetch(`${url}/auth/v1/user`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        apikey: anonKey,
        Authorization: `Bearer ${session.access_token}`
      },
      body: JSON.stringify({ data: { theme } })
    });
  } catch {
    /* best-effort only */
  }
}
