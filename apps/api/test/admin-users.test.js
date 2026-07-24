// Admin area: list/create/edit users, role selector surface, live role
// resolution (capability changes take effect on the next request).
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { buildApp } from '../src/server.js';
import { resetStore } from '../src/store.js';
import {
  resetUsersStore,
  RATCHET_ADMIN_EMAIL,
  RATCHET_EMPLOYEE_EMAIL
} from '../src/usersStore.js';
import { resetInviteRuntime } from '../src/selfAuth.js';
import { GOVERNANCE_ROLES } from '../src/permissions.js';

const SECRET = 'admin-users-test-jwt-secret';
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
    sub: `user-${role}-${(email || role).replace(/[^a-z0-9]/gi, '')}`,
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
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
    DATABASE_URL: process.env.DATABASE_URL,
    COOKIE_INSECURE: process.env.COOKIE_INSECURE
  };
  process.env.SUPABASE_JWT_SECRET = SECRET;
  process.env.COOKIE_INSECURE = '1';
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.DATABASE_URL;
  resetStore();
  resetUsersStore();
  resetInviteRuntime();
  const app = buildApp({ logger: false });
  await app.ready();
  app.__restore = () => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    resetUsersStore();
    resetInviteRuntime();
  };
  return app;
}

test('GET /admin without session redirects away (3xx) or 403', async (t) => {
  const app = await makeApp();
  t.after(() => {
    app.close();
    app.__restore();
  });
  const res = await app.inject({ method: 'GET', url: '/admin' });
  assert.ok(
    res.statusCode === 403 || (res.statusCode >= 300 && res.statusCode < 400),
    `expected 403 or redirect, got ${res.statusCode}`
  );
  assert.ok(
    !/admin-users-table|data-testid="admin-area"/i.test(res.body || ''),
    'unauthenticated response must not include admin user list markup'
  );
});

test('GET /admin as non-admin is 403', async (t) => {
  const app = await makeApp();
  t.after(() => {
    app.close();
    app.__restore();
  });
  const res = await app.inject({
    method: 'GET',
    url: '/admin',
    headers: {
      authorization: `Bearer ${roleToken('employee', RATCHET_EMPLOYEE_EMAIL)}`
    }
  });
  assert.equal(res.statusCode, 403);
  assert.ok(!/admin-users-table/i.test(res.body || ''));
});

test('GET /admin as admin is 200', async (t) => {
  const app = await makeApp();
  t.after(() => {
    app.close();
    app.__restore();
  });
  const res = await app.inject({
    method: 'GET',
    url: '/admin',
    headers: {
      authorization: `Bearer ${roleToken('admin', RATCHET_ADMIN_EMAIL)}`
    }
  });
  assert.equal(res.statusCode, 200);
  assert.match(res.body, /Admin/i);
  assert.match(res.body, /board member/i);
});

test('admin users API: unauth 401, non-admin 403, admin list + five roles', async (t) => {
  const app = await makeApp();
  t.after(() => {
    app.close();
    app.__restore();
  });

  const unauth = await app.inject({ method: 'GET', url: '/api/admin/users' });
  assert.ok([401, 403].includes(unauth.statusCode));
  assert.notEqual(unauth.statusCode, 200);

  const employee = await app.inject({
    method: 'GET',
    url: '/api/admin/users',
    headers: {
      authorization: `Bearer ${roleToken('employee', RATCHET_EMPLOYEE_EMAIL)}`
    }
  });
  assert.equal(employee.statusCode, 403);

  const admin = await app.inject({
    method: 'GET',
    url: '/api/admin/users',
    headers: {
      authorization: `Bearer ${roleToken('admin', RATCHET_ADMIN_EMAIL)}`
    }
  });
  assert.equal(admin.statusCode, 200);
  const body = admin.json();
  assert.ok(Array.isArray(body.users));
  assert.ok(body.users.length >= 2);
  const emails = body.users.map((u) => u.email);
  assert.ok(emails.includes(RATCHET_ADMIN_EMAIL));
  assert.ok(emails.includes(RATCHET_EMPLOYEE_EMAIL));
  assert.deepEqual(body.roles, [...GOVERNANCE_ROLES]);
  for (const role of [
    'admin',
    'executive',
    'board_member',
    'employee',
    'consultant'
  ]) {
    assert.ok(body.roles.includes(role), `missing role ${role}`);
  }
  const employeeRow = body.users.find((u) => u.email === RATCHET_EMPLOYEE_EMAIL);
  assert.equal(employeeRow.role, 'employee');
});

test('admin can create and edit a user', async (t) => {
  const app = await makeApp();
  t.after(() => {
    app.close();
    app.__restore();
  });
  const headers = {
    authorization: `Bearer ${roleToken('admin', RATCHET_ADMIN_EMAIL)}`
  };

  const created = await app.inject({
    method: 'POST',
    url: '/api/admin/users',
    headers,
    payload: {
      email: 'new.member@boardroom.test',
      full_name: 'New Member',
      role: 'consultant'
    }
  });
  assert.equal(created.statusCode, 201);
  const user = created.json().user;
  assert.equal(user.email, 'new.member@boardroom.test');
  assert.equal(user.role, 'consultant');
  assert.equal(user.full_name, 'New Member');

  const list = await app.inject({
    method: 'GET',
    url: '/api/admin/users',
    headers
  });
  assert.ok(
    list.json().users.some((u) => u.email === 'new.member@boardroom.test')
  );

  const patched = await app.inject({
    method: 'PATCH',
    url: `/api/admin/users/${user.id}`,
    headers,
    payload: { full_name: 'Updated Member', role: 'executive' }
  });
  assert.equal(patched.statusCode, 200);
  assert.equal(patched.json().user.full_name, 'Updated Member');
  assert.equal(patched.json().user.role, 'executive');

  const again = await app.inject({
    method: 'GET',
    url: '/api/admin/users',
    headers
  });
  const row = again.json().users.find((u) => u.id === user.id);
  assert.equal(row.full_name, 'Updated Member');
  assert.equal(row.role, 'executive');
});

test('role change takes effect on next request without redeploy', async (t) => {
  const app = await makeApp();
  t.after(() => {
    app.close();
    app.__restore();
  });
  const adminHeaders = {
    authorization: `Bearer ${roleToken('admin', RATCHET_ADMIN_EMAIL)}`
  };

  // Target user authenticates as employee (JWT may still say employee even
  // after promotion — store role must win).
  const targetToken = roleToken('employee', RATCHET_EMPLOYEE_EMAIL);
  const targetHeaders = { authorization: `Bearer ${targetToken}` };

  const denied = await app.inject({
    method: 'GET',
    url: '/api/admin/users',
    headers: targetHeaders
  });
  assert.equal(denied.statusCode, 403);

  const list = await app.inject({
    method: 'GET',
    url: '/api/admin/users',
    headers: adminHeaders
  });
  const target = list.json().users.find((u) => u.email === RATCHET_EMPLOYEE_EMAIL);
  assert.ok(target);

  const promote = await app.inject({
    method: 'PATCH',
    url: `/api/admin/users/${target.id}`,
    headers: adminHeaders,
    payload: { role: 'admin' }
  });
  assert.equal(promote.statusCode, 200);
  assert.equal(promote.json().user.role, 'admin');

  // Fresh request as the same user/token — must now pass (live store role).
  const allowed = await app.inject({
    method: 'GET',
    url: '/api/admin/users',
    headers: targetHeaders
  });
  assert.equal(allowed.statusCode, 200);

  const demote = await app.inject({
    method: 'PATCH',
    url: `/api/admin/users/${target.id}`,
    headers: adminHeaders,
    payload: { role: 'employee' }
  });
  assert.equal(demote.statusCode, 200);

  const deniedAgain = await app.inject({
    method: 'GET',
    url: '/api/admin/users',
    headers: targetHeaders
  });
  assert.equal(deniedAgain.statusCode, 403);
});

test('GET /api/admin exposes five roles', async (t) => {
  const app = await makeApp();
  t.after(() => {
    app.close();
    app.__restore();
  });
  const res = await app.inject({
    method: 'GET',
    url: '/api/admin',
    headers: {
      authorization: `Bearer ${roleToken('admin', RATCHET_ADMIN_EMAIL)}`
    }
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.ok, true);
  assert.deepEqual(body.roles, [...GOVERNANCE_ROLES]);
});
