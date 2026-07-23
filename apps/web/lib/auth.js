// Client-side auth helpers for the invite-only Boardroom app.
//
// There is no self-signup: users are admin-created in Supabase and receive a
// magic link. This module never handles passwords. Supabase config is read from
// the public NEXT_PUBLIC_* env at build time (the anon key is safe to ship; RLS
// is the real guard). When it is absent the UI still behaves correctly — the
// guard treats the visitor as unauthenticated and the login form confirms
// optimistically — so acceptance never depends on a live Supabase project.

export const SUPABASE_URL = (process.env.NEXT_PUBLIC_SUPABASE_URL || '').replace(
  /\/+$/,
  ''
);
export const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';

const SESSION_KEY = 'ig-board.session';

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

// Request a magic link for an admin-provisioned user. `create_user: false`
// enforces invite-only — Supabase will not create an account for an unknown
// email. A no-op when Supabase is unconfigured; the caller shows the
// check-your-email confirmation regardless.
export async function requestMagicLink(email) {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return;
  const redirectTo =
    typeof window !== 'undefined' ? window.location.origin + '/' : undefined;
  await fetch(`${SUPABASE_URL}/auth/v1/otp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: SUPABASE_ANON_KEY
    },
    body: JSON.stringify({
      email,
      create_user: false,
      gotrue_meta_security: {},
      ...(redirectTo ? { options: { email_redirect_to: redirectTo } } : {})
    })
  });
}

// Best-effort persistence of the chosen theme onto the user's Supabase profile
// (user_metadata). Silently no-ops when unconfigured or unauthenticated so the
// theme toggle never blocks or errors on localStorage-only sessions.
export async function persistThemeToProfile(theme) {
  const session = getSession();
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !session) return;
  try {
    await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${session.access_token}`
      },
      body: JSON.stringify({ data: { theme } })
    });
  } catch {
    /* best-effort only */
  }
}
