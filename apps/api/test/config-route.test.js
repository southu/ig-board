// Integration test for the public GET /config route (src/server.js).
//
// The web app ships as a committed static export, so it fetches its browser-safe
// Supabase config from this route at runtime. It must be PUBLIC (no auth) and
// must only ever expose the project URL + anon key — never server secrets.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/server.js';

// Snapshot + restore the env keys this test mutates so it never bleeds into
// other test files sharing the process.
const KEYS = [
  'SUPABASE_URL',
  'SUPABASE_ANON_KEY',
  'SUPABASE_JWT_SECRET',
  'SUPABASE_SERVICE_ROLE_KEY'
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

test('GET /config is public and returns url + minted anon key', async () => {
  await withEnv(
    {
      SUPABASE_URL: 'https://abc123.supabase.co',
      SUPABASE_JWT_SECRET: 'route-test-secret',
      SUPABASE_SERVICE_ROLE_KEY: 'service-role-must-not-leak'
    },
    async () => {
      const app = buildApp({ logger: false });
      await app.ready();
      try {
        // No Authorization header — the login page hits this pre-auth.
        const res = await app.inject({ method: 'GET', url: '/config' });
        assert.equal(res.statusCode, 200);
        const body = res.json();
        assert.equal(body.supabaseUrl, 'https://abc123.supabase.co');
        assert.ok(body.supabaseAnonKey.length > 0, 'anon key present');
        // The minted key is a role:"anon" JWT.
        const payload = JSON.parse(
          Buffer.from(body.supabaseAnonKey.split('.')[1], 'base64url').toString('utf8')
        );
        assert.equal(payload.role, 'anon');
        // Server secrets never leak.
        assert.ok(!res.payload.includes('service-role-must-not-leak'));
        assert.ok(!res.payload.includes('route-test-secret'));
      } finally {
        await app.close();
      }
    }
  );
});

test('GET /config returns empty strings when Supabase is unconfigured', async () => {
  await withEnv({}, async () => {
    const app = buildApp({ logger: false });
    await app.ready();
    try {
      const res = await app.inject({ method: 'GET', url: '/config' });
      assert.equal(res.statusCode, 200);
      assert.deepEqual(res.json(), { supabaseUrl: '', supabaseAnonKey: '' });
    } finally {
      await app.close();
    }
  });
});
