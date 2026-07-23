'use client';

import { useState } from 'react';
import { requestMagicLink, SupabaseUnconfiguredError } from '../../lib/auth';

// The ONLY public page. Invite-only magic-link sign-in: an email field only —
// no password, no self-signup / register CTA. Users are admin-created in
// Supabase; unknown emails simply never receive a link (create_user: false).
export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  async function onSubmit(event) {
    event.preventDefault();
    setSubmitting(true);
    setError('');
    // Fire the magic-link request. Invite-only means a completed request always
    // confirms optimistically — no information leaks about which addresses are
    // provisioned. But if the public Supabase config is missing we FAIL CLOSED
    // with a visible error rather than falsely claiming a link was sent.
    try {
      await requestMagicLink(email.trim());
      setSent(true);
    } catch (err) {
      if (err instanceof SupabaseUnconfiguredError) {
        setError(
          'Sign-in is temporarily unavailable — the server is missing its Supabase configuration. Please contact your administrator.'
        );
      } else {
        // A transport/network error: surface a generic retry prompt without
        // revealing request/delivery status for any specific address.
        setError('We couldn’t reach the sign-in service. Please try again.');
      }
    }
    setSubmitting(false);
  }

  return (
    <div className="auth">
      <div className="auth__card">
        {sent ? (
          <div className="auth__confirm">
            <span className="check" aria-hidden="true">
              ✓
            </span>
            <h1 className="auth__title">Check your email</h1>
            <p className="auth__note">
              If {email.trim() || 'that address'} belongs to a Boardroom member,
              a magic sign-in link is on its way. Open it on this device to
              continue.
            </p>
          </div>
        ) : (
          <form onSubmit={onSubmit} noValidate>
            <p className="eyebrow">The Image Group</p>
            <h1 className="auth__title">Sign in to Boardroom</h1>
            <p className="auth__note">
              Access is invite-only. Enter your work email and we&rsquo;ll send a
              secure magic link — no password required.
            </p>
            <div className="field">
              <label htmlFor="email">Work email</label>
              <input
                id="email"
                name="email"
                type="email"
                inputMode="email"
                autoComplete="email"
                required
                placeholder="you@theimagegroup.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
            {error ? (
              <p className="auth__error" role="alert">
                {error}
              </p>
            ) : null}
            <button className="btn" type="submit" disabled={submitting}>
              {submitting ? 'Sending…' : 'Send magic link'}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
