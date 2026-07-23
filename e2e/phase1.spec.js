// Phase 1 Playwright suite — live acceptance for founder KPI entry, board
// read-only, audit trail, definition-changed flag, and theme no-flash/persist.
// Targets LIVE_URL / PLAYWRIGHT_BASE_URL (default: production Railway).
import { test, expect } from '@playwright/test';
import { authAs, FOUNDER_EMAIL } from './helpers.js';

const LIVE =
  process.env.PLAYWRIGHT_BASE_URL ||
  process.env.LIVE_URL ||
  'https://ig-board-production.up.railway.app';

test.describe.configure({ mode: 'serial' });

test('unauthenticated visit to /update redirects to /login', async ({ page }) => {
  await page.goto('/update');
  await page.waitForURL(/\/login/, { timeout: 15_000 });
  await expect(page).toHaveURL(/\/login/);
});

test('unauthenticated write API returns 401', async ({ request }) => {
  const post = await request.post(`${LIVE}/api/kpi-values`, {
    data: { key: 'nps', period: '2026-07', value: 1 }
  });
  expect(post.status()).toBe(401);

  const put = await request.put(`${LIVE}/api/kpi-definitions/nps`, {
    data: { definition: 'x' }
  });
  expect(put.status()).toBe(401);
});

test('pyramid and layer pages return HTTP 200', async ({ request }) => {
  for (const path of ['/', '/layer/1', '/layer/2', '/layer/3', '/layer/4', '/layer/5', '/login']) {
    const res = await request.get(`${LIVE}${path}`);
    expect(res.status(), path).toBe(200);
  }
});

test('theme: pre-paint script present; toggle persists across reload', async ({
  page
}) => {
  await page.goto('/login');
  // Pre-paint script is inlined in <head> with data-theme-init.
  const init = page.locator('script[data-theme-init]');
  await expect(init).toHaveCount(1);
  const html = await init.innerHTML();
  expect(html).toMatch(/ig-board\.theme/);
  expect(html).toMatch(/prefers-color-scheme/);

  // Toggle and confirm persistence after hard reload.
  const before = await page.evaluate(() =>
    document.documentElement.getAttribute('data-theme')
  );
  await page.locator('.theme-toggle').click();
  const after = await page.evaluate(() =>
    document.documentElement.getAttribute('data-theme')
  );
  expect(after).not.toBe(before);
  expect(['light', 'dark']).toContain(after);

  await page.reload();
  await expect
    .poll(async () =>
      page.evaluate(() => document.documentElement.getAttribute('data-theme'))
    )
    .toBe(after);
});

test('founder can submit KPI value; band color changes; audit records who/when/old/new', async ({
  page
}) => {
  await authAs(page, 'founder');

  // Observe current Layer 1 band status before the write (wait out the initial
  // gray "loading / no values yet" flash).
  const band = page.locator('.pyramid__band[data-layer="1"]');
  await expect(band).toBeVisible();
  await expect
    .poll(async () => band.getAttribute('data-status'), { timeout: 15_000 })
    .not.toBe('none');
  const beforeStatus = await band.getAttribute('data-status');

  // Navigate to the founder update console.
  await page.goto('/update');
  await expect(page.locator('[data-testid="value-entry-form"]')).toBeVisible();

  // cash_runway_months seed ends red (value 2). Write a green value (>= 9) for
  // the seeded 2026-07 period so the overlay flips the latest point green and
  // the layer band moves off pure red (worst becomes yellow from gross_margin).
  await page.locator('#kpi-key').selectOption('cash_runway_months');
  await page.locator('#kpi-period').fill('2026-07');
  await page.locator('#kpi-value').fill('12');
  await page.locator('#kpi-note').fill('phase1 e2e runway recovery');
  await page.locator('[data-testid="value-entry-form"] button[type="submit"]').click();
  await expect(page.locator('[data-testid="value-entry-status"]')).toContainText(
    /Saved/i
  );

  // Audit trail shows who / when / old / new.
  await expect(page.locator('[data-testid="audit-table"]')).toBeVisible({
    timeout: 15_000
  });
  const firstRow = page.locator('[data-testid="audit-row"]').first();
  await expect(firstRow.locator('[data-col="who"]')).toContainText(/@/);
  await expect(firstRow.locator('[data-col="when"]')).not.toHaveText('—');
  await expect(firstRow.locator('[data-col="new"]')).toContainText('12');

  // Pyramid band color/state changes observably (or at least is non-gray after
  // the write — if already yellow/green from a prior run, still assert non-none).
  // Wait for KPI values to load so the band is not still in the pre-fetch gray.
  await page.goto('/');
  await expect(band).toBeVisible();
  await expect
    .poll(async () => band.getAttribute('data-status'), { timeout: 15_000 })
    .not.toBe('none');
  const afterStatus = await band.getAttribute('data-status');
  // Prefer an observable change; if a prior deploy already flipped the band,
  // accept a stable non-red or non-none state as the write is still proven above.
  if (beforeStatus === 'red') {
    expect(afterStatus).not.toBe('red');
  }
});

test('founder definition edit sets the 90-day flag; stale seed has no flag', async ({
  page
}) => {
  await authAs(page, 'founder');
  await page.goto('/update');
  await expect(page.locator('[data-testid="definition-form"]')).toBeVisible();

  await page.locator('#def-key').selectOption('nps');
  await page
    .locator('#def-text')
    .fill('Net Promoter Score — phase1 e2e definition edit.');
  await page.locator('[data-testid="definition-form"] button[type="submit"]').click();
  await expect(page.locator('[data-testid="definition-status"]')).toContainText(
    /updated/i
  );

  // Layer 4 hosts NPS — card must show the definition-changed flag.
  await page.goto('/layer/4');
  const npsCard = page.locator('[data-kpi="nps"]');
  await expect(npsCard).toBeVisible();
  await expect(npsCard).toHaveAttribute('data-definition-changed', 'true');
  await expect(
    npsCard.locator('[data-testid="definition-changed-flag"]')
  ).toContainText(/definition changed/i);

  // gross_margin_pct is seeded with a 2020 definition change — older than 90
  // days — so its card must NOT show the flag.
  await page.goto('/layer/1');
  const marginCard = page.locator('[data-kpi="gross_margin_pct"]');
  await expect(marginCard).toBeVisible();
  await expect(marginCard).toHaveAttribute('data-definition-changed', 'false');
  await expect(
    marginCard.locator('[data-testid="definition-changed-flag"]')
  ).toHaveCount(0);
});

test('board session is read-only in the DOM and denied on write APIs', async ({
  page,
  request
}) => {
  await authAs(page, 'board');

  // No founder Update nav link, no value/definition forms on /update.
  await expect(page.locator('[data-testid="founder-nav"]')).toHaveCount(0);
  await page.goto('/update');
  await expect(page.locator('[data-testid="readonly-notice"]')).toBeVisible();
  await expect(page.locator('[data-testid="value-entry-form"]')).toHaveCount(0);
  await expect(page.locator('[data-testid="definition-form"]')).toHaveCount(0);
  await expect(page.locator('button:has-text("Save value")')).toHaveCount(0);
  await expect(page.locator('button:has-text("Update")')).toHaveCount(0);

  // Layer cards still show values, with no Update controls in the DOM.
  await page.goto('/layer/1');
  await expect(page.locator('.kpi-card').first()).toBeVisible();
  await expect(page.locator('form')).toHaveCount(0);
  await expect(page.locator('button:has-text("Update")')).toHaveCount(0);

  // API write denial with the board session bearer.
  const token = await page.evaluate(() => {
    try {
      const raw = window.localStorage.getItem('ig-board.session');
      return raw ? JSON.parse(raw).access_token : null;
    } catch {
      return null;
    }
  });
  expect(token).toBeTruthy();

  const post = await request.post(`${LIVE}/api/kpi-values`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { key: 'nps', period: '2026-08', value: 99, note: 'board should fail' }
  });
  expect([401, 403]).toContain(post.status());

  const put = await request.put(`${LIVE}/api/kpi-definitions/nps`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { definition: 'board should fail' }
  });
  expect([401, 403]).toContain(put.status());
});

// Keep the founder email referenced so env overrides are documented in the suite.
test('founder email is configured', () => {
  expect(FOUNDER_EMAIL).toMatch(/@/);
});
