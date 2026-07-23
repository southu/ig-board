// Phase 4 Playwright suite — CSV export, /whats-new, WCAG contrast, 375px, motion.
// Targets LIVE_URL / PLAYWRIGHT_BASE_URL (default: production Railway).
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { authAs, BASE_URL } from './helpers.js';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const LIVE = BASE_URL;
const __dirname = dirname(fileURLToPath(import.meta.url));
const SCREENSHOT_DIR = join(__dirname, '..', 'docs', 'screenshots', 'phase4');

test.describe.configure({ mode: 'serial' });

async function forceTheme(page, theme) {
  await page.evaluate((t) => {
    localStorage.setItem('ig-board.theme', t);
    document.documentElement.setAttribute('data-theme', t);
  }, theme);
}

async function noHorizontalOverflow(page) {
  return page.evaluate(() => {
    const doc = document.documentElement;
    const body = document.body;
    return (
      doc.scrollWidth <= doc.clientWidth + 1 &&
      body.scrollWidth <= body.clientWidth + 1
    );
  });
}

test('version endpoint HTTP 200 with sha', async ({ request }) => {
  const res = await request.get(`${LIVE}/version`);
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(typeof body.sha).toBe('string');
  expect(body.sha.length).toBeGreaterThan(6);
});

test('dashboard + layer + trend still HTTP 200 (regression)', async ({
  request
}) => {
  for (const path of ['/', '/layer/1', '/kpi/cash_runway_months']) {
    const res = await request.get(`${LIVE}${path}`);
    expect(res.status(), path).toBe(200);
    const ct = res.headers()['content-type'] || '';
    expect(ct).toMatch(/text\/html/i);
  }
});

test('board CSV export is text/csv with header + data rows', async ({ page }) => {
  await authAs(page, 'board');
  const session = await page.evaluate(() =>
    JSON.parse(window.localStorage.getItem('ig-board.session') || 'null')
  );
  expect(session && session.access_token).toBeTruthy();

  const res = await page.request.get(`${LIVE}/api/export/kpi-values.csv`, {
    headers: { Authorization: `Bearer ${session.access_token}` }
  });
  expect(res.status()).toBe(200);
  const ct = res.headers()['content-type'] || '';
  expect(ct).toMatch(/text\/csv/i);
  const text = await res.text();
  const lines = text.trim().split(/\r?\n/);
  expect(lines[0]).toBe('kpi_key,period,value');
  expect(lines.length).toBeGreaterThan(1);
  expect(text).toMatch(/cash_runway_months|gross_margin_pct|ebitda_margin_pct/);

  // Board UI exposes the export control.
  await page.goto('/');
  await expect(page.locator('[data-testid="board-csv-export"]')).toBeVisible({
    timeout: 20_000
  });
});

test('non-board cannot download CSV (missing UI or 403)', async ({ page }) => {
  await authAs(page, 'founder');
  await page.goto('/');
  await expect(page.locator('.pyramid')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('[data-testid="board-csv-export"]')).toHaveCount(0);

  const session = await page.evaluate(() =>
    JSON.parse(window.localStorage.getItem('ig-board.session') || 'null')
  );
  const res = await page.request.get(`${LIVE}/api/export/kpi-values.csv`, {
    headers: { Authorization: `Bearer ${session.access_token}` }
  });
  expect([401, 403]).toContain(res.status());
});

test('/whats-new HTTP 200; digest after last_seen; revisit empty; no email chrome', async ({
  page
}) => {
  await authAs(page, 'board');

  await page.goto('/whats-new');
  await expect(page.locator('[data-testid="whats-new-page"]')).toBeVisible({
    timeout: 30_000
  });
  // Wait until loading finishes.
  await expect(page.locator('[data-testid="whats-new-loading"]')).toHaveCount(0, {
    timeout: 30_000
  });

  const html = await page.content();
  expect(html).not.toMatch(/mailto:/i);
  expect(html).not.toMatch(/notification-subscribe|subscribe to (email|notif)/i);
  expect(html).not.toMatch(/type=["']email["']/i);

  // First visit may show items or empty if a prior suite run advanced the cursor
  // in the same process — either way, page is 200 and structured.
  const list = page.locator('[data-testid="whats-new-list"]');
  const empty = page.locator('[data-testid="whats-new-empty"]');
  const firstHasList = (await list.count()) > 0;
  const firstHasEmpty = (await empty.count()) > 0;
  expect(firstHasList || firstHasEmpty).toBe(true);

  const firstCount = firstHasList
    ? await page.locator('[data-testid="whats-new-item"]').count()
    : 0;

  // Revisit — empty or reduced.
  await page.goto('/whats-new');
  await expect(page.locator('[data-testid="whats-new-loading"]')).toHaveCount(0, {
    timeout: 30_000
  });
  const secondCount = (await page.locator('[data-testid="whats-new-item"]').count()) || 0;
  expect(secondCount).toBeLessThanOrEqual(firstCount);
  // After a primed cursor, empty is the steady state.
  await expect(page.locator('[data-testid="whats-new-empty"]')).toBeVisible();
});

test('axe contrast: zero serious RAG/text violations in LIGHT', async ({
  page
}) => {
  await authAs(page, 'board');
  await page.goto('/');
  await forceTheme(page, 'light');
  await page.goto('/');
  await expect(page.locator('.pyramid')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');

  for (const path of ['/', '/layer/1', '/kpi/cash_runway_months']) {
    await page.goto(path);
    await page.waitForTimeout(400);
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2aa', 'wcag21aa'])
      .analyze();
    const contrast = (results.violations || []).filter(
      (v) => v.id === 'color-contrast'
    );
    // Filter to RAG-ish / primary text nodes when present; fail on any contrast.
    expect(contrast, `light contrast on ${path}`).toEqual([]);
  }
});

test('axe contrast: zero serious RAG/text violations in DARK', async ({
  page
}) => {
  await authAs(page, 'board');
  await page.goto('/');
  await forceTheme(page, 'dark');
  await page.goto('/');
  await expect(page.locator('.pyramid')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

  for (const path of ['/', '/layer/1', '/kpi/cash_runway_months']) {
    await page.goto(path);
    await page.waitForTimeout(400);
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2aa', 'wcag21aa'])
      .analyze();
    const contrast = (results.violations || []).filter(
      (v) => v.id === 'color-contrast'
    );
    expect(contrast, `dark contrast on ${path}`).toEqual([]);
  }
});

test('at 375px both themes: no horizontal overflow on dashboard + layer', async ({
  page
}) => {
  await authAs(page, 'board');
  await page.setViewportSize({ width: 375, height: 812 });

  for (const theme of ['light', 'dark']) {
    await page.goto('/');
    await forceTheme(page, theme);
    for (const path of ['/', '/layer/1']) {
      await page.goto(path);
      await page.waitForTimeout(300);
      const ok = await noHorizontalOverflow(page);
      expect(ok, `overflow ${theme} ${path}`).toBe(true);
    }
  }
});

test('prefers-reduced-motion reduce disables transitions', async ({ page }) => {
  await authAs(page, 'board');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await expect(page.locator('.pyramid')).toBeVisible({ timeout: 20_000 });

  const motionKilled = await page.evaluate(() => {
    const band = document.querySelector('.pyramid__band');
    const body = document.body;
    if (!band) return false;
    const bandCs = getComputedStyle(band);
    const bodyCs = getComputedStyle(body);
    const none = (v) => !v || v === 'none' || v === '0s' || /^0s\b/.test(v);
    // Under the reduce media query, transitions should collapse to none / 0s.
    return none(bandCs.transitionDuration) && none(bodyCs.transitionDuration);
  });
  expect(motionKilled).toBe(true);
});

test('capture docs/screenshots/phase4 eight required screenshots', async ({
  page
}) => {
  mkdirSync(SCREENSHOT_DIR, { recursive: true });
  await authAs(page, 'board');

  const shots = [
    { file: 'dashboard-light-desktop.png', path: '/', theme: 'light', w: 1280, h: 800 },
    { file: 'dashboard-dark-desktop.png', path: '/', theme: 'dark', w: 1280, h: 800 },
    { file: 'dashboard-light-375.png', path: '/', theme: 'light', w: 375, h: 812 },
    { file: 'dashboard-dark-375.png', path: '/', theme: 'dark', w: 375, h: 812 },
    { file: 'layer-light-desktop.png', path: '/layer/1', theme: 'light', w: 1280, h: 800 },
    { file: 'layer-dark-desktop.png', path: '/layer/1', theme: 'dark', w: 1280, h: 800 },
    { file: 'layer-light-375.png', path: '/layer/1', theme: 'light', w: 375, h: 812 },
    { file: 'layer-dark-375.png', path: '/layer/1', theme: 'dark', w: 375, h: 812 }
  ];

  for (const s of shots) {
    await page.setViewportSize({ width: s.w, height: s.h });
    await page.goto(s.path);
    await forceTheme(page, s.theme);
    await page.goto(s.path);
    await page.waitForTimeout(500);
    const out = join(SCREENSHOT_DIR, s.file);
    await page.screenshot({ path: out, fullPage: true });
    expect(existsSync(out), s.file).toBe(true);
  }
});

test('pyramid shows MANAGE/MONITOR + RAG (regression)', async ({ page }) => {
  await authAs(page, 'board');
  await page.goto('/');
  await expect(page.locator('.pyramid')).toBeVisible({ timeout: 20_000 });
  const text = await page.locator('.pyramid').innerText();
  expect(text).toMatch(/MANAGE/);
  expect(text).toMatch(/MONITOR/);
  // At least one band has a non-none status from seed.
  const statuses = await page.locator('.pyramid__band').evaluateAll((els) =>
    els.map((el) => el.getAttribute('data-status'))
  );
  expect(statuses.some((s) => s && s !== 'none')).toBe(true);
});
