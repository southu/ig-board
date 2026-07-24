// Governance data layer: public status endpoint + in-memory backfill invariants.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/server.js';
import {
  GOVERNANCE_ROLES,
  REACTION_TYPES,
  OPERATOR_ADMIN_EMAIL,
  ensureGovernanceReady,
  governanceStatus,
  resetGovernanceMemory
} from '../src/governance.js';
import { resetCommentsStore, createComment, listComments } from '../src/commentsStore.js';
import { isProtectedRequest, isPublicRequest } from '../src/auth.js';

test('governance status is public (no JWT required)', () => {
  const req = { method: 'GET', url: '/api/governance/status' };
  assert.equal(isProtectedRequest(req), false);
  assert.equal(isPublicRequest(req), true);
});

test('other /api/* routes remain protected', () => {
  assert.equal(
    isProtectedRequest({ method: 'GET', url: '/api/kpi-values' }),
    true
  );
  assert.equal(
    isProtectedRequest({ method: 'GET', url: '/api/comments' }),
    true
  );
});

test('memory governance backfill assigns roles and promotes operator admin', async () => {
  delete process.env.DATABASE_URL;
  resetGovernanceMemory();
  await ensureGovernanceReady({});
  const status = await governanceStatus({});

  assert.deepEqual(status.roles, [...GOVERNANCE_ROLES]);
  assert.deepEqual(status.reaction_types, [...REACTION_TYPES]);
  assert.equal(status.reaction_unique_constraint, true);
  assert.equal(status.comment_soft_delete_fields, true);
  assert.ok(status.total_users > 0);
  assert.equal(status.users_with_role, status.total_users);
  assert.ok(status.admin_count >= 1);
  assert.equal(status.operator_admin_email, OPERATOR_ADMIN_EMAIL);
  assert.equal(typeof status.comment_count, 'number');
  assert.equal(typeof status.kpi_count, 'number');
  assert.ok(status.kpi_count >= 0);
});

test('GET /api/governance/status returns 200 JSON without auth', async (t) => {
  delete process.env.DATABASE_URL;
  resetGovernanceMemory();
  const app = buildApp();
  t.after(async () => {
    await app.close();
  });

  const res = await app.inject({ method: 'GET', url: '/api/governance/status' });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.deepEqual(body.roles.sort(), [...GOVERNANCE_ROLES].sort());
  assert.deepEqual(body.reaction_types.sort(), [...REACTION_TYPES].sort());
  assert.equal(body.reaction_unique_constraint, true);
  assert.equal(body.comment_soft_delete_fields, true);
  assert.ok(body.total_users > 0);
  assert.equal(body.users_with_role, body.total_users);
  assert.ok(body.admin_count >= 1);
  assert.ok(body.operator_admin_email);
  assert.equal(typeof body.comment_count, 'number');
  assert.equal(typeof body.kpi_count, 'number');
});

test('comment soft-delete fields exist but do not change list behavior', () => {
  resetCommentsStore();
  const created = createComment({
    authorId: 'u1',
    authorEmail: 'a@b.co',
    authorRole: 'board',
    body: 'hello governance',
    kpiId: 'bypass_count'
  });
  assert.ok(created);
  // publicComment wire shape must not surface soft-delete (visible behavior).
  assert.equal(created.deleted_at, undefined);
  assert.equal(created.deleted_by, undefined);

  const listed = listComments({ kpiId: 'bypass_count' });
  assert.equal(listed.length, 1);
  assert.equal(listed[0].body, 'hello governance');
});
