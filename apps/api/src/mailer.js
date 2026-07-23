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
// Supported backends (dependency-free — the HTTPS backends use the built-in
// global fetch and the SMTP backend uses the built-in node:net/node:tls, so the
// Railway build gains no lockfile / native-module surface):
//   - RESEND_API_KEY        -> Resend HTTPS API (https://resend.com)
//   - MAIL_WEBHOOK_URL      -> POST { to, subject, html, text } to a relay of your
//                              choosing (SES/Mailgun/Postmark shim, etc.)
//   - SMTP_URL / SMTP_HOST  -> a standard SMTP submission server (implicit TLS on
//                              465, or STARTTLS on 587, with AUTH PLAIN/LOGIN).
//                              This is the credential most operators already hold
//                              (their own mail domain), so it is the easiest path
//                              to arm real delivery without a third-party signup.
//   - SMTP_DIRECT=true      -> ZERO-credential last resort: resolve the
//                              recipient domain's MX and deliver straight to it on
//                              port 25 (STARTTLS when offered), no relay account at
//                              all. This is the logical completion of the "no
//                              third-party signup" path — it needs no secret, so
//                              it is the one backend an operator can arm without
//                              provisioning any credential into the vault. It is
//                              OPT-IN (default off) and never a silent default:
//                              many hosts (Railway included) block outbound port
//                              25, in which case delivery fails HONESTLY (the
//                              caller maps the throw to 502) rather than pretending
//                              — so login still shows a real error, never a false
//                              "check your email".
//
// A verified sender is configured via AUTH_EMAIL_FROM (defaults to a Boardroom
// address). No secret is ever logged or returned to a client.
import net from 'node:net';
import tls from 'node:tls';
import crypto from 'node:crypto';
import { promises as dns } from 'node:dns';

// Parse the SMTP submission config from env. `SMTP_URL`
// (smtps://user:pass@host:port or smtp://user:pass@host:port) wins; otherwise the
// discrete SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASS/SMTP_SECURE names are used.
// Returns null when no SMTP host is configured. Never logs any value.
export function parseSmtpConfig(env = process.env) {
  const url = (env.SMTP_URL || '').trim();
  if (url) {
    let u;
    try {
      u = new URL(url);
    } catch {
      return null;
    }
    const secure = u.protocol === 'smtps:';
    const port = u.port ? Number(u.port) : secure ? 465 : 587;
    return {
      host: u.hostname,
      port,
      secure,
      user: u.username ? decodeURIComponent(u.username) : '',
      pass: u.password ? decodeURIComponent(u.password) : ''
    };
  }
  const host = (env.SMTP_HOST || '').trim();
  if (!host) return null;
  const port = Number((env.SMTP_PORT || '').trim()) || 587;
  const secureRaw = (env.SMTP_SECURE || '').trim().toLowerCase();
  const secure = secureRaw === 'true' || secureRaw === '1' || port === 465;
  return {
    host,
    port,
    secure,
    user: (env.SMTP_USER || '').trim(),
    pass: env.SMTP_PASS || ''
  };
}

// True when the zero-credential direct-to-MX backend is explicitly opted into.
// It carries no password, so it is a non-secret flag (SMTP_DIRECT / MAIL_DIRECT).
// Default OFF: it is never a silent default because it can send real mail to a
// real recipient domain, and it fails where outbound port 25 is blocked.
export function smtpDirectEnabled(env = process.env) {
  const raw = (env.SMTP_DIRECT || env.MAIL_DIRECT || '').trim().toLowerCase();
  return raw === 'true' || raw === '1' || raw === 'yes';
}

// True when a delivery backend is bound. Cheap boolean for callers to branch on
// before minting a grant, so an unconfigured deploy fails closed loudly.
export function mailerConfigured(env = process.env) {
  return (
    (env.RESEND_API_KEY || '').trim().length > 0 ||
    (env.MAIL_WEBHOOK_URL || '').trim().length > 0 ||
    parseSmtpConfig(env) !== null ||
    smtpDirectEnabled(env)
  );
}

function fromAddress(env) {
  return (env.AUTH_EMAIL_FROM || '').trim() || 'Boardroom <login@theimagegroup.com>';
}

// Extract the bare `local@domain` envelope address from a possibly display-name
// wrapped From header ("Boardroom <login@x>" -> "login@x").
function envelopeAddress(from) {
  const m = /<([^>]+)>/.exec(from);
  return (m ? m[1] : from).trim();
}

// ---------------------------------------------------------------------------
// Minimal, dependency-free SMTP submission client (node:net + node:tls only).
//
// SMTP is lockstep — send a command, await one reply — so a single persistent
// data buffer feeds a one-outstanding-read state machine. Supports implicit TLS
// (smtps/465), the STARTTLS upgrade (587), and AUTH PLAIN/LOGIN. It transmits
// exactly one message then QUITs; it is only ever exercised when SMTP_* env is
// bound, so an unconfigured deploy never touches this path.
// ---------------------------------------------------------------------------
function smtpConnection(socket) {
  let buf = '';
  let waiter = null;
  const tryResolve = () => {
    if (!waiter) return;
    for (const line of buf.split(/\r?\n/)) {
      // A final reply line is "NNN " (space); "NNN-" marks a continuation.
      if (/^\d{3} /.test(line)) {
        const w = waiter;
        waiter = null;
        const text = buf;
        buf = '';
        w.resolve({ code: parseInt(line.slice(0, 3), 10), text });
        return;
      }
    }
  };
  const onData = (chunk) => {
    buf += chunk.toString('utf8');
    tryResolve();
  };
  const onErr = (err) => {
    if (waiter) {
      const w = waiter;
      waiter = null;
      w.reject(err);
    }
  };
  let active = socket;
  active.on('data', onData);
  active.on('error', onErr);
  const conn = {
    get socket() {
      return active;
    },
    read() {
      return new Promise((resolve, reject) => {
        waiter = { resolve, reject };
        tryResolve();
      });
    },
    // Attach the reader to the freshly upgraded TLS socket after STARTTLS.
    rebind(next) {
      active.removeListener('data', onData);
      active.removeListener('error', onErr);
      buf = '';
      active = next;
      active.on('data', onData);
      active.on('error', onErr);
    },
    // Write a command and await its (possibly multiline) reply as one step.
    async command(line) {
      const p = this.read();
      active.write(line + '\r\n');
      return p;
    }
  };
  return conn;
}

function expect(res, ok, stage) {
  if (!ok.includes(res.code)) {
    const err = new Error(`smtp ${stage} rejected: ${res.code}`);
    err.smtpCode = res.code;
    throw err;
  }
}

async function sendViaSmtp(cfg, { from, to, subject, html, text }) {
  const connectSocket = () =>
    new Promise((resolve, reject) => {
      const s = cfg.secure
        ? tls.connect({ host: cfg.host, port: cfg.port, servername: cfg.host })
        : net.connect({ host: cfg.host, port: cfg.port });
      const onReady = () => {
        s.removeListener('error', onError);
        resolve(s);
      };
      const onError = (e) => reject(e);
      s.once(cfg.secure ? 'secureConnect' : 'connect', onReady);
      s.once('error', onError);
      s.setTimeout(20000, () => s.destroy(new Error('smtp timeout')));
    });

  const socket = await connectSocket();
  const conn = smtpConnection(socket);
  try {
    expect(await conn.read(), [220], 'greeting');
    const ehloName = 'ig-board';
    let ehlo = await conn.command(`EHLO ${ehloName}`);
    expect(ehlo, [250], 'EHLO');

    // STARTTLS upgrade when offered and not already on an implicit-TLS socket.
    if (!cfg.secure && /STARTTLS/i.test(ehlo.text)) {
      expect(await conn.command('STARTTLS'), [220], 'STARTTLS');
      const secured = await new Promise((resolve, reject) => {
        const t = tls.connect({ socket, servername: cfg.host }, () => resolve(t));
        t.once('error', reject);
      });
      conn.rebind(secured);
      ehlo = await conn.command(`EHLO ${ehloName}`);
      expect(ehlo, [250], 'EHLO(tls)');
    }

    // Authenticate when credentials are present and the server advertises AUTH.
    if (cfg.user && /AUTH[ =-]/i.test(ehlo.text)) {
      if (/PLAIN/i.test(ehlo.text)) {
        const token = Buffer.from(`\0${cfg.user}\0${cfg.pass}`).toString('base64');
        expect(await conn.command(`AUTH PLAIN ${token}`), [235], 'AUTH');
      } else {
        expect(await conn.command('AUTH LOGIN'), [334], 'AUTH LOGIN');
        expect(
          await conn.command(Buffer.from(cfg.user).toString('base64')),
          [334],
          'AUTH user'
        );
        expect(
          await conn.command(Buffer.from(cfg.pass).toString('base64')),
          [235],
          'AUTH pass'
        );
      }
    }

    expect(await conn.command(`MAIL FROM:<${envelopeAddress(from)}>`), [250], 'MAIL FROM');
    expect(await conn.command(`RCPT TO:<${to}>`), [250, 251], 'RCPT TO');
    expect(await conn.command('DATA'), [354], 'DATA');

    const message = buildRfc822({ from, to, subject, html, text });
    // Dot-stuffing: a line beginning "." must be escaped as ".." per RFC 5321.
    const dotStuffed = message.replace(/\r\n\./g, '\r\n..');
    expect(await conn.command(`${dotStuffed}\r\n.`), [250], 'message');

    try {
      await conn.command('QUIT');
    } catch {
      // The server may drop the connection on QUIT; delivery already succeeded.
    }
    return { ok: true, status: 250 };
  } finally {
    conn.socket.destroy();
  }
}

// Zero-credential delivery: look up the recipient domain's MX records and hand
// the message straight to the highest-priority exchange on port 25 (STARTTLS is
// negotiated by sendViaSmtp when the server advertises it; no AUTH — there are no
// credentials). Tries exchanges in priority order and returns on the first that
// accepts the message. If DNS yields no usable host, or every exchange refuses /
// the network blocks port 25, the final error propagates so the caller fails
// HONESTLY (mapped to 502) instead of pretending the mail was sent.
async function sendViaDirectMx({ from, to, subject, html, text }) {
  const domain = (to.split('@')[1] || '').trim().toLowerCase();
  if (!domain) throw new Error('direct-mx: recipient has no domain');

  let exchanges;
  try {
    const mx = await dns.resolveMx(domain);
    exchanges = mx
      .filter((r) => r && r.exchange)
      .sort((a, b) => a.priority - b.priority)
      .map((r) => r.exchange);
  } catch (err) {
    // No MX record: RFC 5321 falls back to the domain's A/AAAA record as the
    // implicit mail exchange.
    exchanges = [domain];
  }
  if (exchanges.length === 0) exchanges = [domain];

  let lastErr;
  for (const host of exchanges) {
    try {
      // No submission credentials: bare port-25 relay, upgrade to TLS if offered.
      return await sendViaSmtp(
        { host, port: 25, secure: false, user: '', pass: '' },
        { from, to, subject, html, text }
      );
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error('direct-mx: no mail exchange accepted the message');
}

// Assemble a multipart/alternative RFC 822 message (plain + HTML) with proper
// CRLF line endings. crypto supplies the boundary + Message-ID (no reliance on
// Math.random for uniqueness).
function buildRfc822({ from, to, subject, html, text }) {
  const boundary = `=_ig_${crypto.randomUUID()}`;
  const messageId = `<${crypto.randomUUID()}@ig-board>`;
  const domain = envelopeAddress(from).split('@')[1] || 'ig-board';
  const headers = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    `Message-ID: ${messageId.replace('@ig-board>', `@${domain}>`)}`,
    `Date: ${new Date().toUTCString()}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`
  ];
  const body = [
    `--${boundary}`,
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: 7bit',
    '',
    text,
    `--${boundary}`,
    'Content-Type: text/html; charset=utf-8',
    'Content-Transfer-Encoding: 7bit',
    '',
    html,
    `--${boundary}--`,
    ''
  ];
  return `${headers.join('\r\n')}\r\n\r\n${body.join('\r\n')}`.replace(/\r?\n/g, '\r\n');
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

  const smtp = parseSmtpConfig(env);
  if (smtp) {
    return sendViaSmtp(smtp, { from: fromAddress(env), to: email, subject, html, text });
  }

  // Zero-credential last resort — only when explicitly opted in (SMTP_DIRECT).
  if (smtpDirectEnabled(env)) {
    return sendViaDirectMx({ from: fromAddress(env), to: email, subject, html, text });
  }

  return { ok: false, status: 0, unconfigured: true };
}
