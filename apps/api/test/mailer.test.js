// Unit tests for the magic-link mailer's backend selection and the dependency-free
// SMTP submission client. The SMTP path is exercised end-to-end against a tiny
// in-process mock SMTP server (node:net) so the full command conversation — EHLO,
// AUTH PLAIN, MAIL FROM/RCPT TO, DATA, dot-terminated message — is verified
// without any real network or third-party credential.
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import {
  mailerConfigured,
  parseSmtpConfig,
  sendMagicLink
} from '../src/mailer.js';

const SMTP_KEYS = [
  'RESEND_API_KEY',
  'MAIL_WEBHOOK_URL',
  'SMTP_URL',
  'SMTP_HOST',
  'SMTP_PORT',
  'SMTP_USER',
  'SMTP_PASS',
  'SMTP_SECURE',
  'AUTH_EMAIL_FROM'
];

function cleanEnv(overrides = {}) {
  const env = {};
  for (const k of SMTP_KEYS) env[k] = undefined;
  return { ...env, ...overrides };
}

test('parseSmtpConfig reads SMTP_URL (implicit TLS on smtps)', () => {
  const cfg = parseSmtpConfig(
    cleanEnv({ SMTP_URL: 'smtps://user%40x:p%40ss@smtp.example.com:465' })
  );
  assert.deepEqual(cfg, {
    host: 'smtp.example.com',
    port: 465,
    secure: true,
    user: 'user@x', // percent-decoded
    pass: 'p@ss'
  });
});

test('parseSmtpConfig reads discrete SMTP_* names; STARTTLS port defaults to 587', () => {
  const cfg = parseSmtpConfig(
    cleanEnv({ SMTP_HOST: 'mail.local', SMTP_USER: 'board', SMTP_PASS: 'pw' })
  );
  assert.equal(cfg.host, 'mail.local');
  assert.equal(cfg.port, 587);
  assert.equal(cfg.secure, false);
});

test('parseSmtpConfig returns null when no SMTP host is configured', () => {
  assert.equal(parseSmtpConfig(cleanEnv()), null);
});

test('mailerConfigured is true for any bound backend, false with none', () => {
  assert.equal(mailerConfigured(cleanEnv()), false);
  assert.equal(mailerConfigured(cleanEnv({ RESEND_API_KEY: 'k' })), true);
  assert.equal(mailerConfigured(cleanEnv({ MAIL_WEBHOOK_URL: 'https://x' })), true);
  assert.equal(mailerConfigured(cleanEnv({ SMTP_HOST: 'mail.local' })), true);
  assert.equal(
    mailerConfigured(cleanEnv({ SMTP_URL: 'smtp://mail.local:587' })),
    true
  );
});

// A minimal mock SMTP server that scripts the standard submission conversation
// and captures the DATA payload. Resolves with the captured session once the
// client QUITs (or disconnects).
function startMockSmtp() {
  const session = { commands: [], data: '', from: '', rcpt: '' };
  let resolveDone;
  const done = new Promise((r) => (resolveDone = r));
  const server = net.createServer((socket) => {
    let buf = '';
    let inData = false;
    socket.write('220 mock ESMTP ready\r\n');
    socket.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let idx;
      while ((idx = buf.indexOf('\r\n')) !== -1) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        if (inData) {
          if (line === '.') {
            inData = false;
            socket.write('250 2.0.0 Ok queued\r\n');
          } else {
            // Undo dot-stuffing so the captured body matches what was built.
            session.data += (line.startsWith('..') ? line.slice(1) : line) + '\r\n';
          }
          continue;
        }
        session.commands.push(line);
        const upper = line.toUpperCase();
        if (upper.startsWith('EHLO')) {
          socket.write('250-mock greets you\r\n250 AUTH PLAIN LOGIN\r\n');
        } else if (upper.startsWith('AUTH PLAIN')) {
          socket.write('235 2.7.0 Authentication successful\r\n');
        } else if (upper.startsWith('MAIL FROM')) {
          session.from = line;
          socket.write('250 2.1.0 Ok\r\n');
        } else if (upper.startsWith('RCPT TO')) {
          session.rcpt = line;
          socket.write('250 2.1.5 Ok\r\n');
        } else if (upper === 'DATA') {
          inData = true;
          socket.write('354 End data with <CR><LF>.<CR><LF>\r\n');
        } else if (upper === 'QUIT') {
          socket.write('221 2.0.0 Bye\r\n');
          socket.end();
        } else {
          socket.write('250 2.0.0 Ok\r\n');
        }
      }
    });
    socket.on('close', () => resolveDone(session));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ port: server.address().port, server, done });
    });
  });
}

test('sendMagicLink delivers via SMTP: authenticates, sends the message, carries the link', async () => {
  const mock = await startMockSmtp();
  try {
    const env = cleanEnv({
      SMTP_HOST: '127.0.0.1',
      SMTP_PORT: String(mock.port),
      SMTP_USER: 'board',
      SMTP_PASS: 'pw',
      AUTH_EMAIL_FROM: 'Boardroom <login@theimagegroup.com>'
    });
    const actionLink =
      'https://ig-board-production.up.railway.app/auth/v1/verify?token=abc&type=magiclink';
    const res = await sendMagicLink(
      { email: 'board@theimagegroup.com', actionLink },
      env
    );
    assert.equal(res.ok, true, 'SMTP delivery reported success');

    const session = await mock.done;
    // The full submission conversation happened, in order.
    assert.ok(session.commands.some((c) => c.startsWith('EHLO')));
    const authLine = session.commands.find((c) => c.startsWith('AUTH PLAIN '));
    assert.ok(authLine, 'authenticated with AUTH PLAIN');
    // SASL PLAIN token must decode to \0authcid\0passwd (NUL-delimited, not spaces).
    const decoded = Buffer.from(authLine.slice('AUTH PLAIN '.length), 'base64').toString('utf8');
    assert.equal(decoded, '\0board\0pw');
    assert.match(session.from, /MAIL FROM:<login@theimagegroup\.com>/);
    assert.match(session.rcpt, /RCPT TO:<board@theimagegroup\.com>/);
    // The magic link reached the message body (both the HTML and text parts).
    assert.ok(session.data.includes(actionLink), 'action link present in message');
    assert.match(session.data, /Content-Type: multipart\/alternative/);
    assert.match(session.data, /Subject: Your Boardroom sign-in link/);
  } finally {
    mock.server.close();
  }
});

test('sendMagicLink reports unconfigured when no backend is bound', async () => {
  const res = await sendMagicLink(
    { email: 'x@y.com', actionLink: 'https://x/verify' },
    cleanEnv()
  );
  assert.equal(res.ok, false);
  assert.equal(res.unconfigured, true);
});
