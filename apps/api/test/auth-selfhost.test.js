// Integration tests for the self-hosted Supabase-Auth backend (src/server.js).
//
// When no external Supabase project is provisioned but SUPABASE_JWT_SECRET is
// bound (the live BUG-1 state), the service serves itself as the auth origin:
//   - GET /config returns supabaseUrl = this request's own origin + a minted
//     anon key (never the JWT secret / service-role key).
//   - POST /auth/v1/otp accepts the magic-link request at that same origin so
//     the login page issues a real network call instead of failing closed.
//     Invite-only is preserved: it never issues a session token.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/server.js';

const HOST = 'ig-board-production.up.railway.app';
const ORIGIN = `https://${HOST}`;
const PROXY = { host: HOST, 'x-forwarded-proto': 'https' };

// Env keys these tests mutate; snapshot + restore so they never bleed across the
// shared test process.
const KEYS = [
  'SUPABASE_URL',
  'SUPABASE_ANON_KEY',
  'NEXT_PUBLIC_SUPABASE_URL',
  'NEXT_PUBLIC_SUPABASE_ANON_KEY',
  'SUPABASE_JWT_SECRET',
  'JWT_SECRET',
  'SUPABASE_SERVICE_ROLE_KEY',
  'RAILWAY_PUBLIC_DOMAIN',
  'RAILWAY_STATIC_URL',
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

// Stub global fetch to capture the mailer's outbound delivery call without any
// real network. Returns { calls, restore }.
function stubMailerFetch({ ok = true, status = 200 } = {}) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, opts });
    return { ok, status, json: async () => ({}), text: async () => '' };
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

function withEnv(overrides, fn) {
  const saved = {};
  for (const k of KEYS) saved[k] = process.env[k];
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, overrides);
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const k of KEYS) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    });
}

test('GET /config self-hosts at the request origin when only the JWT secret is bound', async () => {
  await withEnv({ SUPABASE_JWT_SECRET: 'selfhost-secret' }, async () => {
    const app = buildApp({ logger: false });
    await app.ready();
    try {
      const res = await app.inject({ method: 'GET', url: '/config', headers: PROXY });
      assert.equal(res.statusCode, 200);
      const body = res.json();
      assert.equal(body.supabaseUrl, ORIGIN, 'points the client at this origin');
      assert.ok(body.supabaseAnonKey.length > 0, 'anon key present');
      const payload = JSON.parse(
        Buffer.from(body.supabaseAnonKey.split('.')[1], 'base64url').toString('utf8')
      );
      assert.equal(payload.role, 'anon');
      // The signing secret is never a payload value and must not appear.
      assert.ok(!res.payload.includes('selfhost-secret'));
    } finally {
      await app.close();
    }
  });
});

test('POST /auth/v1/otp sends a magic link (200) when a mailer is configured', async () => {
  await withEnv(
    { SUPABASE_JWT_SECRET: 'selfhost-secret', RESEND_API_KEY: 'test-resend-key' },
    async () => {
      const mail = stubMailerFetch();
      const app = buildApp({ logger: false });
      await app.ready();
      try {
        const cfg = (
          await app.inject({ method: 'GET', url: '/config', headers: PROXY })
        ).json();
        const res = await app.inject({
          method: 'POST',
          url: '/auth/v1/otp',
          headers: { ...PROXY, 'content-type': 'application/json', apikey: cfg.supabaseAnonKey },
          payload: { email: 'board.e2e@boardroom.test', create_user: false }
        });
        assert.equal(res.statusCode, 200, 'a real OTP request is accepted once delivered');
        // Never leaks a session token to the unauthenticated OTP caller.
        assert.ok(!res.payload.includes('access_token'));
        // The mailer was actually invoked with a same-origin verify link.
        assert.equal(mail.calls.length, 1, 'delivery attempted exactly once');
        const sentBody = JSON.parse(mail.calls[0].opts.body);
        assert.ok(
          JSON.stringify(sentBody).includes(`${ORIGIN}/auth/v1/verify`),
          'email carries the self-hosted verify link'
        );
        // The signing secret must never appear in the outbound email payload.
        assert.ok(!JSON.stringify(sentBody).includes('selfhost-secret'));
      } finally {
        await app.close();
        mail.restore();
      }
    }
  );
});

test('POST /auth/v1/otp returns an inline action link (self-hosted demo, no mailer, no external project)', async () => {
  await withEnv({ SUPABASE_JWT_SECRET: 'selfhost-secret' }, async () => {
    const app = buildApp({ logger: false });
    await app.ready();
    try {
      const cfg = (
        await app.inject({ method: 'GET', url: '/config', headers: PROXY })
      ).json();
      const res = await app.inject({
        method: 'POST',
        url: '/auth/v1/otp',
        headers: { ...PROXY, 'content-type': 'application/json', apikey: cfg.supabaseAnonKey },
        payload: { email: 'board.e2e@boardroom.test' }
      });
      // No external project means /config pointed the browser here and no mailer
      // can reach an inbox, so the sole sign-in path is completed by handing the
      // verify link back inline (the mission's "deliverable link"), NOT a 503.
      assert.equal(res.statusCode, 200, 'self-hosted demo hands the link back inline');
      const body = res.json();
      assert.ok(
        typeof body.action_link === 'string' &&
          body.action_link.includes(`${ORIGIN}/auth/v1/verify`),
        'response carries a same-origin verify link'
      );
      // The link is a grant, never a ready session: no access token is leaked to
      // the unauthenticated OTP caller, and the signing secret never appears.
      assert.ok(!res.payload.includes('access_token'), 'no session token leaked');
      assert.ok(!res.payload.includes('selfhost-secret'), 'signing secret never leaks');
    } finally {
      await app.close();
    }
  });
});

test('POST /auth/v1/otp is 503 when an external project is set but no mailer is bound', async () => {
  await withEnv(
    {
      SUPABASE_JWT_SECRET: 'selfhost-secret',
      SUPABASE_URL: 'https://example.supabase.co'
    },
    async () => {
      const app = buildApp({ logger: false });
      await app.ready();
      try {
        const cfg = (
          await app.inject({ method: 'GET', url: '/config', headers: PROXY })
        ).json();
        const res = await app.inject({
          method: 'POST',
          url: '/auth/v1/otp',
          headers: { ...PROXY, 'content-type': 'application/json', apikey: cfg.supabaseAnonKey },
          payload: { email: 'board.e2e@boardroom.test' }
        });
        // An external project is expected to deliver email itself — the inline
        // link fallback must NOT engage; stay honest and fail closed.
        assert.equal(res.statusCode, 503, 'external project + no mailer -> fail closed');
        assert.equal(res.json().error, 'email_delivery_unconfigured');
        assert.ok(!res.payload.includes('action_link'), 'no inline link when external project set');
      } finally {
        await app.close();
      }
    }
  );
});

test('magic-link round trip: otp -> verify redirect -> real session accepted by /me', async () => {
  await withEnv(
    { SUPABASE_JWT_SECRET: 'selfhost-secret', RESEND_API_KEY: 'test-resend-key' },
    async () => {
      const mail = stubMailerFetch();
      const app = buildApp({ logger: false });
      await app.ready();
      try {
        const cfg = (
          await app.inject({ method: 'GET', url: '/config', headers: PROXY })
        ).json();
        // 1) Request the link — captures the emailed verify URL from the mailer.
        await app.inject({
          method: 'POST',
          url: '/auth/v1/otp',
          headers: { ...PROXY, 'content-type': 'application/json', apikey: cfg.supabaseAnonKey },
          payload: {
            email: 'board.e2e@boardroom.test',
            options: { email_redirect_to: `${ORIGIN}/` }
          }
        });
        const emailBody = JSON.parse(mail.calls[0].opts.body);
        const linkMatch = JSON.stringify(emailBody).match(
          /https:\/\/[^"\\]+\/auth\/v1\/verify\?[^"\\]+/
        );
        assert.ok(linkMatch, 'email contains a verify link');
        const verifyPath = linkMatch[0].replace(ORIGIN, '');

        // 2) Follow the link — verify redirects to the app with a session hash.
        const verifyRes = await app.inject({ method: 'GET', url: verifyPath, headers: PROXY });
        assert.equal(verifyRes.statusCode, 302);
        const location = verifyRes.headers.location;
        assert.ok(location.startsWith(`${ORIGIN}/#`), 'redirects home with a fragment');
        const hash = location.split('#')[1];
        const params = new URLSearchParams(hash);
        const accessToken = params.get('access_token');
        assert.ok(accessToken, 'session access token present in the fragment');

        // 3) The minted session authenticates the real API (no faked localStorage).
        const meRes = await app.inject({
          method: 'GET',
          url: '/me',
          headers: { ...PROXY, authorization: `Bearer ${accessToken}` }
        });
        assert.equal(meRes.statusCode, 200);
        const me = meRes.json();
        assert.equal(me.role, 'board', 'authenticated member gets the board role');
        assert.ok(me.id, 'stable user id');
      } finally {
        await app.close();
        mail.restore();
      }
    }
  );
});

test('the public anon key from /config cannot read the private API (BUG-2)', async () => {
  await withEnv({ SUPABASE_JWT_SECRET: 'selfhost-secret' }, async () => {
    const app = buildApp({ logger: false });
    await app.ready();
    try {
      // The same anon key GET /config hands every browser.
      const cfg = (
        await app.inject({ method: 'GET', url: '/config', headers: PROXY })
      ).json();
      assert.ok(cfg.supabaseAnonKey.length > 0);
      const anonAuth = { ...PROXY, authorization: `Bearer ${cfg.supabaseAnonKey}` };

      // It must NOT authorize private data access...
      const kpi = await app.inject({ method: 'GET', url: '/api/kpi-values', headers: anonAuth });
      assert.equal(kpi.statusCode, 401, 'anon key rejected by /api/kpi-values');

      const me = await app.inject({ method: 'GET', url: '/me', headers: anonAuth });
      assert.equal(me.statusCode, 401, 'anon key rejected by /me');

      // ...and it must NOT mint a synthetic authenticated user.
      const user = await app.inject({ method: 'GET', url: '/auth/v1/user', headers: anonAuth });
      assert.equal(user.statusCode, 401, 'anon key does not mint a board user');
    } finally {
      await app.close();
    }
  });
});

test('a real magic-link session CAN read the private API and identify its user', async () => {
  await withEnv(
    { SUPABASE_JWT_SECRET: 'selfhost-secret', RESEND_API_KEY: 'test-resend-key' },
    async () => {
      const mail = stubMailerFetch();
      const app = buildApp({ logger: false });
      await app.ready();
      try {
        const cfg = (
          await app.inject({ method: 'GET', url: '/config', headers: PROXY })
        ).json();
        await app.inject({
          method: 'POST',
          url: '/auth/v1/otp',
          headers: { ...PROXY, 'content-type': 'application/json', apikey: cfg.supabaseAnonKey },
          payload: { email: 'board.e2e@boardroom.test', options: { email_redirect_to: `${ORIGIN}/` } }
        });
        const linkMatch = JSON.stringify(JSON.parse(mail.calls[0].opts.body)).match(
          /https:\/\/[^"\\]+\/auth\/v1\/verify\?[^"\\]+/
        );
        const verifyRes = await app.inject({
          method: 'GET',
          url: linkMatch[0].replace(ORIGIN, ''),
          headers: PROXY
        });
        const accessToken = new URLSearchParams(
          verifyRes.headers.location.split('#')[1]
        ).get('access_token');
        const sessionAuth = { ...PROXY, authorization: `Bearer ${accessToken}` };

        // The genuine session is accepted where the anon key was rejected.
        const kpi = await app.inject({ method: 'GET', url: '/api/kpi-values', headers: sessionAuth });
        assert.equal(kpi.statusCode, 200);
        const user = await app.inject({ method: 'GET', url: '/auth/v1/user', headers: sessionAuth });
        assert.equal(user.statusCode, 200);
        assert.equal(user.json().email, 'board.e2e@boardroom.test');
      } finally {
        await app.close();
        mail.restore();
      }
    }
  );
});

test('GET /auth/v1/verify redirects to /login on an invalid/expired grant', async () => {
  await withEnv({ SUPABASE_JWT_SECRET: 'selfhost-secret' }, async () => {
    const app = buildApp({ logger: false });
    await app.ready();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/auth/v1/verify?token=not.a.valid.grant&type=magiclink',
        headers: PROXY
      });
      assert.equal(res.statusCode, 302);
      assert.ok(res.headers.location.startsWith(`${ORIGIN}/login#error=`));
      assert.ok(!res.headers.location.includes('access_token'));
    } finally {
      await app.close();
    }
  });
});

test('POST /auth/v1/otp rejects a missing or forged apikey with 401', async () => {
  await withEnv({ SUPABASE_JWT_SECRET: 'selfhost-secret' }, async () => {
    const app = buildApp({ logger: false });
    await app.ready();
    try {
      const missing = await app.inject({
        method: 'POST',
        url: '/auth/v1/otp',
        headers: { ...PROXY, 'content-type': 'application/json' },
        payload: { email: 'board.e2e@boardroom.test' }
      });
      assert.equal(missing.statusCode, 401);

      const forged = await app.inject({
        method: 'POST',
        url: '/auth/v1/otp',
        headers: { ...PROXY, 'content-type': 'application/json', apikey: 'not.a.jwt' },
        payload: { email: 'board.e2e@boardroom.test' }
      });
      assert.equal(forged.statusCode, 401);
    } finally {
      await app.close();
    }
  });
});

test('POST /auth/v1/otp rejects an invalid email with 400', async () => {
  await withEnv({ SUPABASE_JWT_SECRET: 'selfhost-secret' }, async () => {
    const app = buildApp({ logger: false });
    await app.ready();
    try {
      const cfg = (
        await app.inject({ method: 'GET', url: '/config', headers: PROXY })
      ).json();
      const res = await app.inject({
        method: 'POST',
        url: '/auth/v1/otp',
        headers: { ...PROXY, 'content-type': 'application/json', apikey: cfg.supabaseAnonKey },
        payload: { email: 'not-an-email' }
      });
      assert.equal(res.statusCode, 400);
    } finally {
      await app.close();
    }
  });
});

test('POST /auth/v1/otp is 503 when no auth backend is configured at all', async () => {
  await withEnv({}, async () => {
    const app = buildApp({ logger: false });
    await app.ready();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/auth/v1/otp',
        headers: { ...PROXY, 'content-type': 'application/json', apikey: 'x' },
        payload: { email: 'board.e2e@boardroom.test' }
      });
      assert.equal(res.statusCode, 503);
      // And /config stays empty so the client fails closed.
      const cfg = (
        await app.inject({ method: 'GET', url: '/config', headers: PROXY })
      ).json();
      assert.deepEqual(cfg, { supabaseUrl: '', supabaseAnonKey: '' });
    } finally {
      await app.close();
    }
  });
});

test('POST /auth/v1/otp never returns action_link for a non-member (invite-only)', async () => {
  await withEnv({ SUPABASE_JWT_SECRET: 'selfhost-secret' }, async () => {
    const app = buildApp({ logger: false });
    await app.ready();
    try {
      const cfg = (
        await app.inject({ method: 'GET', url: '/config', headers: PROXY })
      ).json();
      for (const create_user of [false, true]) {
        const res = await app.inject({
          method: 'POST',
          url: '/auth/v1/otp',
          headers: {
            ...PROXY,
            'content-type': 'application/json',
            apikey: cfg.supabaseAnonKey
          },
          payload: { email: 'outsider@example.com', create_user }
        });
        // Silent 200 (no enumeration) and never a usable grant.
        assert.equal(res.statusCode, 200, `create_user=${create_user}`);
        const body = res.json();
        assert.ok(!body.action_link, `no action_link create_user=${create_user}`);
        assert.ok(!res.payload.includes('access_token'));
        assert.ok(!res.payload.includes('eyJ'), 'no JWT leaked in OTP body');
      }
    } finally {
      await app.close();
    }
  });
});

test('POST /auth/v1/verify refuses a forged grant for a non-member', async () => {
  await withEnv({ SUPABASE_JWT_SECRET: 'selfhost-secret' }, async () => {
    const app = buildApp({ logger: false });
    await app.ready();
    try {
      const cfg = (
        await app.inject({ method: 'GET', url: '/config', headers: PROXY })
      ).json();
      // Mint a grant offline the same way the server would (simulates a stale or
      // crafted token for an outsider) — verify must still refuse a session.
      const { mintGrantToken } = await import('../src/selfAuth.js');
      const grant = mintGrantToken('selfhost-secret', 'outsider@example.com');
      const verify = await app.inject({
        method: 'POST',
        url: '/auth/v1/verify',
        headers: {
          ...PROXY,
          'content-type': 'application/json',
          apikey: cfg.supabaseAnonKey
        },
        payload: { token: grant, type: 'magiclink' }
      });
      assert.equal(verify.statusCode, 401);
      assert.ok(!verify.payload.includes('access_token'));
    } finally {
      await app.close();
    }
  });
});

test('AUTH_INVITE_ALLOWLIST permits an extra invited member to complete OTP', async () => {
  await withEnv(
    {
      SUPABASE_JWT_SECRET: 'selfhost-secret',
      AUTH_INVITE_ALLOWLIST: 'partner@example.com'
    },
    async () => {
      const app = buildApp({ logger: false });
      await app.ready();
      try {
        const cfg = (
          await app.inject({ method: 'GET', url: '/config', headers: PROXY })
        ).json();
        const res = await app.inject({
          method: 'POST',
          url: '/auth/v1/otp',
          headers: {
            ...PROXY,
            'content-type': 'application/json',
            apikey: cfg.supabaseAnonKey
          },
          payload: { email: 'partner@example.com', create_user: false }
        });
        assert.equal(res.statusCode, 200);
        const body = res.json();
        assert.ok(
          typeof body.action_link === 'string' && body.action_link.includes('/auth/v1/verify'),
          'invited member receives inline action_link on self-hosted demo'
        );
      } finally {
        await app.close();
      }
    }
  );
});
