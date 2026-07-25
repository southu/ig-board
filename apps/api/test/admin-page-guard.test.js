// Server-side gate on the admin PAGE route(s). The admin API surface is covered
// by admin-users / permissions-routes; this file locks down the HTML gate on
// GET /admin (+ aliases) so a non-admin — including an unauthenticated visitor
// hitting the route directly with curl, bypassing the client-side UI — can never
// receive the admin shell. Exercises the real Fastify surface via app.inject().
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { buildApp } from '../src/server.js';
import { resetStore } from '../src/store.js';
import { SESSION_COOKIE } from '../src/auth.js';

const SECRET = 'admin-page-guard-test-jwt-secret';
const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
const now = () => Math.floor(Date.now() / 1000);

function signJwt(payload, secret = SECRET) {
  const header = b64({ alg: 'HS256', typ: 'JWT' });
  const body = b64(payload);
  const sig = crypto
    .createHmac('sha256', secret)
    .update(`${header}.${body}`)
    .digest('base64url');
  return `${header}.${body}.${sig}`;
}

function roleToken(role, email) {
  return signJwt({
    sub: `user-${role}`,
    email: email || `${role}.e2e@boardroom.test`,
    aud: 'authenticated',
    role: 'authenticated',
    app_metadata: { role },
    exp: now() + 3600
  });
}

async function makeApp() {
  const prev = {
    SUPABASE_JWT_SECRET: process.env.SUPABASE_JWT_SECRET,
    SUPABASE_URL: process.env.SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY
  };
  process.env.SUPABASE_JWT_SECRET = SECRET;
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  resetStore();
  const app = buildApp({ logger: false });
  await app.ready();
  app.__restore = () => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
  return app;
}

// True when a response body carries admin-panel content. Covers both serving
// modes: the built Next export (its admin page emits `admin-role-catalog`) and
// the API-only fallback shell (`admin-fallback`). A denied response must contain
// NEITHER; an admitted admin response must contain admin markup.
function leaksAdminContent(body) {
  return body.includes('admin-role-catalog') || body.includes('admin-fallback');
}

test('GET /admin without a session redirects away from admin content', async (t) => {
  const app = await makeApp();
  t.after(() => {
    app.close();
    app.__restore();
  });

  for (const url of ['/admin', '/admin/', '/admin.html']) {
    const res = await app.inject({ method: 'GET', url });
    assert.equal(res.statusCode, 302, `${url} should redirect`);
    assert.equal(res.headers.location, '/login', `${url} should point at /login`);
    assert.ok(
      !leaksAdminContent(res.body),
      `${url} must not leak the admin shell`
    );
  }
});

test('GET /admin with a non-admin session is forbidden (403), no admin markup', async (t) => {
  const app = await makeApp();
  t.after(() => {
    app.close();
    app.__restore();
  });

  const res = await app.inject({
    method: 'GET',
    url: '/admin',
    headers: { authorization: `Bearer ${roleToken('board_member')}` }
  });
  assert.equal(res.statusCode, 403);
  assert.ok(
    !leaksAdminContent(res.body),
    'non-admin must not receive the admin shell'
  );
});

test('GET /admin with an admin session returns the admin shell (200)', async (t) => {
  const app = await makeApp();
  t.after(() => {
    app.close();
    app.__restore();
  });

  const res = await app.inject({
    method: 'GET',
    url: '/admin',
    headers: { authorization: `Bearer ${roleToken('admin')}` }
  });
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-type'] || '', /text\/html/);
  assert.ok(leaksAdminContent(res.body), 'admin must receive admin markup');
});

test('GET /admin authorizes via the session cookie, not only a bearer header', async (t) => {
  const app = await makeApp();
  t.after(() => {
    app.close();
    app.__restore();
  });

  // A non-admin cookie is still refused (403) — the gate reads the role, not
  // merely the presence of a cookie.
  const denied = await app.inject({
    method: 'GET',
    url: '/admin',
    headers: { cookie: `${SESSION_COOKIE}=${roleToken('employee')}` }
  });
  assert.equal(denied.statusCode, 403);
  assert.ok(!leaksAdminContent(denied.body));

  // An admin cookie is admitted.
  const allowed = await app.inject({
    method: 'GET',
    url: '/admin',
    headers: { cookie: `${SESSION_COOKIE}=${roleToken('admin')}` }
  });
  assert.equal(allowed.statusCode, 200);
  assert.ok(leaksAdminContent(allowed.body), 'admin cookie must receive admin markup');
});

test('a garbage/forged token is treated as unauthenticated (redirect, no leak)', async (t) => {
  const app = await makeApp();
  t.after(() => {
    app.close();
    app.__restore();
  });

  // Signed with the wrong secret: signature verification must fail closed.
  const forged = roleToken('admin') + 'x';
  const res = await app.inject({
    method: 'GET',
    url: '/admin',
    headers: { authorization: `Bearer ${forged}` }
  });
  assert.ok(
    [301, 302, 303, 307, 401, 403].includes(res.statusCode),
    `forged token must not yield 200 (got ${res.statusCode})`
  );
  assert.ok(!leaksAdminContent(res.body));
});
