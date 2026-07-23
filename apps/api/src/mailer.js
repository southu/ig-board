// Magic-link delivery for the self-hosted auth backend.
//
// The whole point of a magic link is that the secret grant reaches the member
// OUT OF BAND — in their inbox — so possessing it proves control of the address.
// That requires a real mailer. This module is that seam, and it is deliberately
// HONEST: when no delivery backend is configured, sending fails (it does NOT
// pretend), so the login page shows "temporarily unavailable" instead of a false
// "check your email". Binding a delivery backend (see below) lights real magic
// links up with no code change.
//
// Supported backends (dependency-free — all use the built-in global fetch, so the
// Railway build gains no lockfile / native-module surface):
//   - RESEND_API_KEY        -> Resend HTTPS API (https://resend.com)
//   - MAIL_WEBHOOK_URL      -> POST { to, subject, html, text } to a relay of your
//                              choosing (SES/Mailgun/Postmark shim, etc.)
//
// A verified sender is configured via AUTH_EMAIL_FROM (defaults to a Boardroom
// address). No secret is ever logged or returned to a client.

// True when a delivery backend is bound. Cheap boolean for callers to branch on
// before minting a grant, so an unconfigured deploy fails closed loudly.
export function mailerConfigured(env = process.env) {
  return (
    (env.RESEND_API_KEY || '').trim().length > 0 ||
    (env.MAIL_WEBHOOK_URL || '').trim().length > 0
  );
}

function fromAddress(env) {
  return (env.AUTH_EMAIL_FROM || '').trim() || 'Boardroom <login@theimagegroup.com>';
}

function renderEmail(actionLink) {
  const subject = 'Your Boardroom sign-in link';
  const html =
    `<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;` +
    `max-width:480px;margin:0 auto;padding:24px">` +
    `<p style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;` +
    `color:#6b7280;margin:0 0 8px">The Image Group</p>` +
    `<h1 style="font-size:20px;margin:0 0 12px">Sign in to Boardroom</h1>` +
    `<p style="color:#374151;line-height:1.5;margin:0 0 20px">Click the button ` +
    `below to sign in. This link is single-use and expires in one hour. If you ` +
    `didn't request it, you can ignore this email.</p>` +
    `<p style="margin:0 0 24px"><a href="${actionLink}" ` +
    `style="display:inline-block;background:#111827;color:#fff;text-decoration:none;` +
    `padding:12px 20px;border-radius:8px;font-weight:600">Open Boardroom</a></p>` +
    `<p style="color:#9ca3af;font-size:12px;line-height:1.5;margin:0">Or paste ` +
    `this URL into your browser:<br>${actionLink}</p>` +
    `</div>`;
  const text = `Sign in to Boardroom (expires in 1 hour):\n\n${actionLink}\n`;
  return { subject, html, text };
}

// Send the magic-link email. Returns { ok, status, unconfigured }. Never throws
// for a normal HTTP error (the caller maps !ok to a 502/503); only a transport
// failure propagates.
export async function sendMagicLink({ email, actionLink }, env = process.env) {
  const { subject, html, text } = renderEmail(actionLink);

  const resendKey = (env.RESEND_API_KEY || '').trim();
  if (resendKey) {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${resendKey}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ from: fromAddress(env), to: [email], subject, html })
    });
    return { ok: res.ok, status: res.status };
  }

  const webhook = (env.MAIL_WEBHOOK_URL || '').trim();
  if (webhook) {
    const res = await fetch(webhook, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ to: email, from: fromAddress(env), subject, html, text })
    });
    return { ok: res.ok, status: res.status };
  }

  return { ok: false, status: 0, unconfigured: true };
}
