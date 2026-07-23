// Tests for the server-only Supabase admin config (src/supabaseAdmin.js).
//
// These verify the fail-closed behaviour and header/URL construction WITHOUT any
// network: fetch is stubbed. The point is to confirm apps/api can be wired to
// reach Supabase with the service-role key from env only, and that it refuses to
// run when unconfigured.
import test from 'node:test';
import assert from 'node:assert/strict';
import { adminConfig, isAdminConfigured, adminFetch } from '../src/supabaseAdmin.js';

function withEnv(vars, fn) {
  const prev = {};
  for (const [k, v] of Object.entries(vars)) {
    prev[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test('adminConfig fails closed when unconfigured', () => {
  withEnv({ SUPABASE_URL: undefined, SUPABASE_SERVICE_ROLE_KEY: undefined }, () => {
    assert.equal(isAdminConfigured(), false);
    assert.throws(() => adminConfig(), /SUPABASE_URL is not set/);
  });
  withEnv({ SUPABASE_URL: 'https://ref.supabase.co', SUPABASE_SERVICE_ROLE_KEY: undefined }, () => {
    assert.equal(isAdminConfigured(), false);
    assert.throws(() => adminConfig(), /SERVICE_ROLE_KEY is not set/);
  });
});

test('adminConfig trims and strips a trailing slash from the URL', () => {
  withEnv({ SUPABASE_URL: 'https://ref.supabase.co/', SUPABASE_SERVICE_ROLE_KEY: '  key-123  ' }, () => {
    assert.equal(isAdminConfigured(), true);
    assert.deepEqual(adminConfig(), { url: 'https://ref.supabase.co', serviceRoleKey: 'key-123' });
  });
});

test('adminFetch sends apikey + service-role bearer against SUPABASE_URL', async () => {
  await withEnv({ SUPABASE_URL: 'https://ref.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'svc-key' }, async () => {
    const realFetch = globalThis.fetch;
    let seen = null;
    globalThis.fetch = async (url, opts) => {
      seen = { url, opts };
      return { ok: true, status: 200 };
    };
    try {
      const res = await adminFetch('/rest/v1/users?select=id', { method: 'GET' });
      assert.equal(res.status, 200);
      assert.equal(seen.url, 'https://ref.supabase.co/rest/v1/users?select=id');
      assert.equal(seen.opts.headers.apikey, 'svc-key');
      assert.equal(seen.opts.headers.Authorization, 'Bearer svc-key');
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

// Mission guarantee: the server admin path uses the service-role key ONLY. The
// anon key is a client-side (browser) identifier and must never stand in for, or
// leak into, server-side admin ops — see docs/env.md. These lock that in.
test('the anon key never substitutes for the service-role key (server admin path)', () => {
  // Anon key present but no service-role key -> still fails closed. The anon key
  // is not a valid server credential; admin ops must refuse to run.
  withEnv(
    { SUPABASE_URL: 'https://ref.supabase.co', SUPABASE_ANON_KEY: 'anon-public-key', SUPABASE_SERVICE_ROLE_KEY: undefined },
    () => {
      assert.equal(isAdminConfigured(), false);
      assert.throws(() => adminConfig(), /SERVICE_ROLE_KEY is not set/);
    }
  );
});

test('adminFetch never sends the anon key, even when it is set in the environment', async () => {
  await withEnv(
    { SUPABASE_URL: 'https://ref.supabase.co', SUPABASE_ANON_KEY: 'anon-public-key', SUPABASE_SERVICE_ROLE_KEY: 'svc-key' },
    async () => {
      const realFetch = globalThis.fetch;
      let seen = null;
      globalThis.fetch = async (url, opts) => {
        seen = { url, opts };
        return { ok: true, status: 200 };
      };
      try {
        await adminFetch('/rest/v1/users?select=id', { method: 'GET' });
        // Only the service-role key is used for auth; the anon key is absent.
        assert.equal(seen.opts.headers.apikey, 'svc-key');
        assert.equal(seen.opts.headers.Authorization, 'Bearer svc-key');
        const headerBlob = JSON.stringify(seen.opts.headers);
        assert.ok(!headerBlob.includes('anon-public-key'), 'anon key must never appear in admin request headers');
      } finally {
        globalThis.fetch = realFetch;
      }
    }
  );
});
