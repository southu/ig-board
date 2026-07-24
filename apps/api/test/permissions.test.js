// Unit tests for the authoritative role → capability map.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CAPABILITIES,
  PERMISSIONS,
  GOVERNANCE_ROLES,
  capabilitiesForRole,
  hasCapability,
  canonicalRole,
  canExportKpiCsv,
  sessionPayload
} from '../src/permissions.js';

const ALL_FOUR = [
  'input_kpi_data',
  'edit_kpi_data',
  'delete_any_comment',
  'access_admin_area'
];

test('CAPABILITIES lists the four mission capabilities', () => {
  assert.deepEqual([...CAPABILITIES].sort(), [...ALL_FOUR].sort());
});

test('admin has all four capabilities', () => {
  assert.deepEqual(capabilitiesForRole('admin').sort(), [...ALL_FOUR].sort());
  for (const cap of ALL_FOUR) {
    assert.equal(hasCapability('admin', cap), true);
  }
});

test('board_member has none of the four capabilities', () => {
  assert.deepEqual(capabilitiesForRole('board_member'), []);
  for (const cap of ALL_FOUR) {
    assert.equal(hasCapability('board_member', cap), false);
  }
});

test('executive has exactly input_kpi_data + edit_kpi_data', () => {
  assert.deepEqual(capabilitiesForRole('executive').sort(), [
    'edit_kpi_data',
    'input_kpi_data'
  ]);
  assert.equal(hasCapability('executive', 'input_kpi_data'), true);
  assert.equal(hasCapability('executive', 'edit_kpi_data'), true);
  assert.equal(hasCapability('executive', 'delete_any_comment'), false);
  assert.equal(hasCapability('executive', 'access_admin_area'), false);
});

test('employee has input_kpi_data only', () => {
  assert.deepEqual(capabilitiesForRole('employee'), ['input_kpi_data']);
  assert.equal(hasCapability('employee', 'input_kpi_data'), true);
  assert.equal(hasCapability('employee', 'edit_kpi_data'), false);
  assert.equal(hasCapability('employee', 'delete_any_comment'), false);
  assert.equal(hasCapability('employee', 'access_admin_area'), false);
});

test('consultant has input_kpi_data only', () => {
  assert.deepEqual(capabilitiesForRole('consultant'), ['input_kpi_data']);
  assert.equal(hasCapability('consultant', 'input_kpi_data'), true);
  assert.equal(hasCapability('consultant', 'edit_kpi_data'), false);
});

test('legacy founder aliases admin capabilities; board aliases board_member', () => {
  assert.deepEqual(
    capabilitiesForRole('founder').sort(),
    capabilitiesForRole('admin').sort()
  );
  assert.deepEqual(
    capabilitiesForRole('board'),
    capabilitiesForRole('board_member')
  );
  assert.equal(canonicalRole('founder'), 'admin');
  assert.equal(canonicalRole('board'), 'board_member');
});

test('PERMISSIONS is the single source for every governance role', () => {
  for (const role of GOVERNANCE_ROLES) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(PERMISSIONS, role),
      `missing PERMISSIONS entry for ${role}`
    );
  }
});

test('unknown / null roles deny all capabilities', () => {
  assert.deepEqual(capabilitiesForRole(null), []);
  assert.deepEqual(capabilitiesForRole('nope'), []);
  assert.equal(hasCapability(null, 'input_kpi_data'), false);
  assert.equal(hasCapability('nope', 'input_kpi_data'), false);
});

test('canExportKpiCsv allows board audience, denies admin/founder', () => {
  assert.equal(canExportKpiCsv('board_member'), true);
  assert.equal(canExportKpiCsv('board'), true);
  assert.equal(canExportKpiCsv('executive'), true);
  assert.equal(canExportKpiCsv('admin'), false);
  assert.equal(canExportKpiCsv('founder'), false);
  assert.equal(canExportKpiCsv(null), false);
});

test('sessionPayload exposes canonical role + capabilities', () => {
  const admin = sessionPayload({
    userId: 'u1',
    role: 'admin',
    email: 'a@b.co'
  });
  assert.equal(admin.role, 'admin');
  assert.deepEqual(admin.capabilities.sort(), [...ALL_FOUR].sort());

  const legacyFounder = sessionPayload({ userId: 'u2', role: 'founder' });
  assert.equal(legacyFounder.role, 'admin');
  assert.deepEqual(legacyFounder.capabilities.sort(), [...ALL_FOUR].sort());

  const board = sessionPayload({ userId: 'u3', role: 'board_member' });
  assert.equal(board.role, 'board_member');
  assert.deepEqual(board.capabilities, []);
});
