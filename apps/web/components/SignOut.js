'use client';

import { useEffect, useState } from 'react';
import { clearSession, getSession, serverSignOut } from '../lib/auth';

// Visible only when a session is present. Marks the post-login shell as distinct
// from /login (signed-in state + log-out control). Initial render is null so
// unauthenticated static HTML never contains "Log out" markup (AC5).
export default function SignOut() {
  const [signedIn, setSignedIn] = useState(false);
  // Declared BEFORE the early return below: React hooks must run in the same
  // order on every render. When useEffect flips `signedIn` to true, this render
  // path is taken; if this hook lived after `return null` the hook count would
  // jump 2 -> 3 and React would throw "Rendered more hooks than during the
  // previous render", crashing the Log out control so it never appears.
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setSignedIn(Boolean(getSession()));
  }, []);

  if (!signedIn) return null;

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
      aria-label="Log out"
    >
      Log out
    </button>
  );
}
