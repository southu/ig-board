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
  'RAILWAY_STATIC_URL'
];

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

test('POST /auth/v1/otp accepts a valid magic-link request with the minted apikey', async () => {
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
        payload: { email: 'board@theimagegroup.com', create_user: false }
      });
      assert.equal(res.statusCode, 200, 'a real OTP request is accepted');
      // Never leaks a session token to an unauthenticated caller.
      assert.ok(!res.payload.includes('access_token'));
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
        payload: { email: 'board@theimagegroup.com' }
      });
      assert.equal(missing.statusCode, 401);

      const forged = await app.inject({
        method: 'POST',
        url: '/auth/v1/otp',
        headers: { ...PROXY, 'content-type': 'application/json', apikey: 'not.a.jwt' },
        payload: { email: 'board@theimagegroup.com' }
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
        payload: { email: 'board@theimagegroup.com' }
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
