'use client';

import { useEffect, useState } from 'react';
import { clearSession, getSession, serverSignOut } from '../lib/auth';

// Visible only when a session is present. Marks the post-login shell as distinct
// from /login (signed-in state + sign-out control). Initial render is null so
// unauthenticated static HTML never contains "Sign out" markup (AC5).
export default function SignOut() {
  const [signedIn, setSignedIn] = useState(false);

  useEffect(() => {
    setSignedIn(Boolean(getSession()));
  }, []);

  if (!signedIn) return null;

  const [busy, setBusy] = useState(false);

  async function onSignOut() {
    if (busy) return;
    setBusy(true);
    // Revoke the session server-side FIRST (awaited), so the previously-issued
    // token is unusable for any later authenticated request — then discard the
    // client copy and redirect. Clearing local state alone left the token valid.
    try {
      await serverSignOut();
    } finally {
      clearSession();
      window.location.replace('/login');
    }
  }

  return (
    <button
      type="button"
      className="nav-link nav-link--button"
      onClick={onSignOut}
      disabled={busy}
      data-testid="sign-out"
      data-signed-in="true"
      aria-label="Sign out"
    >
      Sign out
    </button>
  );
}
