'use client';

import { useEffect, useState } from 'react';
import { captureCallbackSession, getSession } from '../lib/auth';

// Client-side guard for every non-login route. Unauthenticated visitors are
// redirected to /login before any protected content is shown. Runs only in the
// browser (static export prerenders the neutral loading state).
export default function AuthGuard({ children }) {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    // A magic-link redirect lands here with the session in the URL fragment.
    captureCallbackSession();
    if (getSession()) {
      setReady(true);
    } else {
      window.location.replace('/login');
    }
  }, []);

  if (!ready) {
    return (
      <div className="route-guard" aria-busy="true">
        Checking your session…
      </div>
    );
  }
  return children;
}
