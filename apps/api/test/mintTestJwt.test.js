// Tests for the pure helpers of scripts/mint-test-jwt.mjs — the response parsing
// and email resolution used to mint a founder/board JWT for the live /me check.
// No network: only the pure functions are exercised. Importing the module must
// NOT run its CLI main() (guarded by the import.meta.url check).
import test from 'node:test';
import assert from 'node:assert/strict';
import { pickAccessToken, resolveEmail } from '../../../scripts/mint-test-jwt.mjs';

test('pickAccessToken reads a top-level access_token', () => {
  assert.equal(pickAccessToken({ access_token: 'abc.def.ghi' }), 'abc.def.ghi');
});

test('pickAccessToken reads a session-nested access_token', () => {
  assert.equal(pickAccessToken({ session: { access_token: 'jwt-123' } }), 'jwt-123');
});

test('pickAccessToken returns null when absent or malformed', () => {
  assert.equal(pickAccessToken(null), null);
  assert.equal(pickAccessToken('nope'), null);
  assert.equal(pickAccessToken({}), null);
  assert.equal(pickAccessToken({ access_token: '' }), null);
  assert.equal(pickAccessToken({ session: {} }), null);
});

test('resolveEmail prefers an explicit positional address', () => {
  assert.equal(resolveEmail(['  ops@example.com  '], {}), 'ops@example.com');
  // A positional wins even if a role flag is also present.
  assert.equal(resolveEmail(['--founder', 'ops@example.com'], {}), 'ops@example.com');
});

test('resolveEmail maps role flags to the documented defaults', () => {
  assert.equal(resolveEmail(['--founder'], {}), 'admin.e2e@boardroom.test');
  assert.equal(resolveEmail(['--admin'], {}), 'admin.e2e@boardroom.test');
  assert.equal(resolveEmail(['--board'], {}), 'board_member.e2e@boardroom.test');
  assert.equal(resolveEmail(['--board-member'], {}), 'board_member.e2e@boardroom.test');
});

test('resolveEmail honours env overrides for the role flags', () => {
  const env = {
    FOUNDER_TEST_EMAIL: 'f+e2e@corp.test',
    BOARD_TEST_EMAIL: 'b+e2e@corp.test',
    ADMIN_TEST_EMAIL: 'a+e2e@corp.test',
    BOARD_MEMBER_TEST_EMAIL: 'bm+e2e@corp.test'
  };
  assert.equal(resolveEmail(['--founder'], env), 'a+e2e@corp.test');
  assert.equal(resolveEmail(['--admin'], env), 'a+e2e@corp.test');
  assert.equal(resolveEmail(['--board'], env), 'bm+e2e@corp.test');
  assert.equal(resolveEmail(['--board-member'], env), 'bm+e2e@corp.test');
  const legacyOnly = {
    FOUNDER_TEST_EMAIL: 'f+e2e@corp.test',
    BOARD_TEST_EMAIL: 'b+e2e@corp.test'
  };
  assert.equal(resolveEmail(['--founder'], legacyOnly), 'f+e2e@corp.test');
  assert.equal(resolveEmail(['--board'], legacyOnly), 'b+e2e@corp.test');
});

test('resolveEmail returns null when nothing selects a user', () => {
  assert.equal(resolveEmail([], {}), null);
  assert.equal(resolveEmail(['--verbose'], {}), null);
});
