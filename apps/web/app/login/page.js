'use client';

import { useState } from 'react';
import {
  requestMagicLink,
  isValidEmail,
  SupabaseUnconfiguredError,
  MagicLinkDeliveryError,
  InvalidEmailError
} from '../../lib/auth';

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
    setError('');
    // Catch obviously-malformed input up front so a bad address never reaches
    // the "check your email" confirmation (no false success).
    const trimmed = email.trim();
    if (!isValidEmail(trimmed)) {
      setError('Enter a valid work email address.');
      return;
    }
    setSubmitting(true);
    // Only confirm ("Check your email") once the server reports the link was
    // actually sent. Every failure path FAILS CLOSED with an honest message
    // rather than falsely claiming a link is on its way.
    try {
      const { actionLink } = await requestMagicLink(trimmed);
      // Self-hosted demo (no mailer): the server handed the link back inline —
      // follow it to complete sign-in (verify -> session in the URL fragment ->
      // the app captures it). Otherwise the link was emailed: confirm and wait.
      if (actionLink) {
        window.location.assign(actionLink);
        return;
      }
      setSent(true);
    } catch (err) {
      if (err instanceof InvalidEmailError) {
        setError('Enter a valid work email address.');
      } else if (
        err instanceof SupabaseUnconfiguredError ||
        err instanceof MagicLinkDeliveryError
      ) {
        setError(
          'Sign-in is temporarily unavailable — magic-link delivery isn’t configured on this deployment yet. Please contact your administrator.'
        );
      } else {
        // A transport/network error: surface a generic retry prompt.
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
