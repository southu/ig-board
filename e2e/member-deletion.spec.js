import { test, expect } from '@playwright/test';
import { authAs, BASE_URL, signIn } from './helpers.js';

async function adminToken(page) {
  return page.evaluate(() => JSON.parse(localStorage.getItem('ig-board.session') || '{}').access_token);
}

async function createMember(page, email, fullName) {
  const token = await adminToken(page);
  const create = await page.request.post(`${BASE_URL}/api/admin/users`, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    data: { email, full_name: fullName, role: 'employee' }
  });
  expect(create.status()).toBe(201);
  return { token, member: (await create.json()).user };
}

test('admin member deletion requires cancel then a separately confirmed assessment and refreshes persisted state', async ({ page }) => {
  await authAs(page, 'founder');
  const email = `delete-ui-${Date.now()}@boardroom.test`;
  const { token, member } = await createMember(page, email, 'UI Delete Candidate');

  await page.goto('/admin');
  const control = page.locator(`[data-testid="admin-delete-${email}"]`);
  await expect(control).toBeVisible({ timeout: 30_000 });
  await control.click();
  await expect(page.locator('[data-testid="member-delete-dialog"]')).toContainText('UI Delete Candidate');
  await page.getByTestId('member-delete-cancel').click();
  expect((await page.request.get(`${BASE_URL}/api/admin/members/${member.id}`, { headers: { Authorization: `Bearer ${token}` } })).status()).toBe(200);

  await control.click();
  const confirm = page.getByTestId('member-delete-confirm');
  await expect(confirm).toBeEnabled({ timeout: 30_000 });
  await confirm.click();
  await expect(page.locator(`[data-user-id="${member.id}"]`)).toHaveCount(0, { timeout: 30_000 });
  await page.reload();
  await expect(page.locator(`[data-user-id="${member.id}"]`)).toHaveCount(0, { timeout: 30_000 });
});

test('blocked member deletion shows the live comment dependency and remains persisted after cancellation', async ({ page }) => {
  await authAs(page, 'founder');
  const email = `delete-comment-${Date.now()}@boardroom.test`;
  const { member } = await createMember(page, email, 'Comment Delete Candidate');

  // The production comments API records its author in commentsStore. Sign in
  // as the new member so this is a real author dependency, then return to the
  // administrator session that performs the assessment.
  await signIn(page, email);
  const memberToken = await adminToken(page);
  const comment = await page.request.post(`${BASE_URL}/api/comments`, {
    headers: { Authorization: `Bearer ${memberToken}`, 'Content-Type': 'application/json' },
    data: { body: 'Member deletion must be blocked by this comment.', kpi_id: 'revenue' }
  });
  expect(comment.status()).toBe(201);

  await authAs(page, 'founder');
  await page.goto('/admin');
  await page.getByTestId(`admin-delete-${email}`).click();
  const dialog = page.getByTestId('member-delete-dialog');
  await expect(dialog.getByTestId('member-delete-blocked')).toContainText('public.comments.author_id');
  await expect(dialog.getByTestId('member-delete-confirm')).toBeDisabled();
  await dialog.getByTestId('member-delete-cancel').click();
  await page.reload();
  await expect(page.locator(`[data-user-id="${member.id}"]`)).toHaveCount(1, { timeout: 30_000 });
});

test('a changed member invalidates an already enabled deletion confirmation', async ({ page }) => {
  await authAs(page, 'founder');
  const email = `delete-stale-${Date.now()}@boardroom.test`;
  const { token, member } = await createMember(page, email, 'Stale Delete Candidate');

  await page.goto('/admin');
  await page.getByTestId(`admin-delete-${email}`).click();
  const dialog = page.getByTestId('member-delete-dialog');
  await expect(dialog.getByTestId('member-delete-confirm')).toBeEnabled({ timeout: 30_000 });
  const changed = await page.request.patch(`${BASE_URL}/api/admin/users/${member.id}`, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    data: { full_name: 'Changed after assessment' }
  });
  expect(changed.status()).toBe(200);
  await dialog.getByTestId('member-delete-confirm').click();
  await expect(dialog.getByTestId('member-delete-message')).toContainText(/no longer current|reassess/i);
  expect((await page.request.get(`${BASE_URL}/api/admin/members/${member.id}`, { headers: { Authorization: `Bearer ${token}` } })).status()).toBe(200);
  await page.reload();
  await expect(page.locator(`[data-user-id="${member.id}"]`)).toHaveCount(1, { timeout: 30_000 });
});

test('unauthenticated callers cannot assess or delete members', async ({ request }) => {
  const id = '00000000-0000-4000-8000-000000000000';
  expect((await request.get(`${BASE_URL}/api/admin/members/${id}/deletion-assessment`)).status()).toBe(401);
  expect((await request.delete(`${BASE_URL}/api/admin/members/${id}`, { data: { confirmation: 'not-a-confirmation' } })).status()).toBe(401);
});
