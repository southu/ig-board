import { test, expect } from '@playwright/test';
import { authAs, BASE_URL } from './helpers.js';

test('admin member deletion requires cancel then a separately confirmed assessment and refreshes persisted state', async ({ page }) => {
  await authAs(page, 'founder');
  const token = await page.evaluate(() => JSON.parse(localStorage.getItem('ig-board.session') || '{}').access_token);
  const email = `delete-ui-${Date.now()}@boardroom.test`;
  const create = await page.request.post(`${BASE_URL}/api/admin/users`, { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, data: { email, full_name: 'UI Delete Candidate', role: 'employee' } });
  expect(create.status()).toBe(201);
  const member = (await create.json()).user;

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

test('unauthenticated callers cannot assess or delete members', async ({ request }) => {
  const id = '00000000-0000-4000-8000-000000000000';
  expect((await request.get(`${BASE_URL}/api/admin/members/${id}/deletion-assessment`)).status()).toBe(401);
  expect((await request.delete(`${BASE_URL}/api/admin/members/${id}`, { data: { confirmation: 'not-a-confirmation' } })).status()).toBe(401);
});
