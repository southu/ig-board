import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { buildApp } from '../src/server.js';
import { resetUsersStore } from '../src/usersStore.js';
import { resetInviteRuntime } from '../src/selfAuth.js';
import { resetMemberDeletionConfirmations } from '../src/memberDeletion.js';

const SECRET = 'member-deletion-test-secret';
const b64 = (v) => Buffer.from(JSON.stringify(v)).toString('base64url');
function token(role, email) {
  const h = b64({ alg: 'HS256', typ: 'JWT' });
  const p = b64({ sub: `test-${role}-${email}`, email, role: 'authenticated', app_metadata: { role }, exp: Math.floor(Date.now() / 1000) + 3600 });
  return `${h}.${p}.${crypto.createHmac('sha256', SECRET).update(`${h}.${p}`).digest('base64url')}`;
}
async function appForTest(t) {
  const previous = process.env.SUPABASE_JWT_SECRET;
  process.env.SUPABASE_JWT_SECRET = SECRET;
  delete process.env.DATABASE_URL;
  resetUsersStore(); resetInviteRuntime(); resetMemberDeletionConfirmations();
  const app = buildApp({ logger: false }); await app.ready();
  t.after(async () => { await app.close(); resetUsersStore(); resetInviteRuntime(); resetMemberDeletionConfirmations(); if (previous === undefined) delete process.env.SUPABASE_JWT_SECRET; else process.env.SUPABASE_JWT_SECRET = previous; });
  return app;
}

test('member deletion requires an admin assessment and consumes its confirmation', async (t) => {
  const app = await appForTest(t);
  const admin = { authorization: `Bearer ${token('admin', 'ratchet-admin@boardroom.test')}` };
  const employee = { authorization: `Bearer ${token('employee', 'ratchet-employee@boardroom.test')}` };
  const created = await app.inject({ method: 'POST', url: '/api/admin/users', headers: admin, payload: { email: 'delete.me@boardroom.test', role: 'employee' } });
  assert.equal(created.statusCode, 201);
  const id = created.json().user.id;
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/admin/members/${id}`, headers: admin })).statusCode, 428);
  assert.equal((await app.inject({ method: 'GET', url: `/api/admin/members/${id}/deletion-assessment`, headers: employee })).statusCode, 403);
  assert.equal((await app.inject({ method: 'GET', url: `/api/admin/members/${id}/deletion-assessment` })).statusCode, 401);
  const assessed = await app.inject({ method: 'GET', url: `/api/admin/members/${id}/deletion-assessment`, headers: admin });
  assert.equal(assessed.statusCode, 200);
  const body = assessed.json();
  assert.equal(body.allowed, true);
  assert.equal(body.related_counts['public.kpi_values.recorded_by'], 0);
  assert.ok(body.confirmation);
  const deleted = await app.inject({ method: 'DELETE', url: `/api/admin/members/${id}`, headers: admin, payload: { confirmation: body.confirmation } });
  assert.equal(deleted.statusCode, 200);
  assert.equal((await app.inject({ method: 'GET', url: `/api/admin/members/${id}`, headers: admin })).statusCode, 404);
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/admin/members/${id}`, headers: admin, payload: { confirmation: body.confirmation } })).statusCode, 409);
});
