'use client';

import { useEffect, useState } from 'react';
import { clearSession, getSession } from '../lib/auth';

// Visible only when a session is present. Marks the post-login shell as distinct
// from /login (signed-in state + sign-out control). Initial render is null so
// unauthenticated static HTML never contains "Sign out" markup (AC5).
export default function SignOut() {
  const [signedIn, setSignedIn] = useState(false);

  useEffect(() => {
    setSignedIn(Boolean(getSession()));
  }, []);

  if (!signedIn) return null;

  function onSignOut() {
    clearSession();
    window.location.replace('/login');
  }

  return (
    <button
      type="button"
      className="nav-link nav-link--button"
      onClick={onSignOut}
      data-testid="sign-out"
      data-signed-in="true"
      aria-label="Sign out"
    >
      Sign out
    </button>
  );
}
