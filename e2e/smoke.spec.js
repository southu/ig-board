// Operator live smoke suite — day-to-day path against LIVE_URL.
// Credentials: SMOKE_FOUNDER_EMAIL / SMOKE_FOUNDER_PASSWORD /
//              SMOKE_BOARD_EMAIL / SMOKE_BOARD_PASSWORD (and optional JWT aliases).
// Never hardcode passwords, tokens, or secrets. See docs/operator-smoke.md.
import { test, expect } from '@playwright/test';
import {
  LIVE_URL,
  smokeCredentials,
  missingFounderReason,
  missingBoardReason,
  authFounder,
  authBoard
} from './smoke-helpers.js';

test.describe.configure({ mode: 'serial' });

test.describe('operator smoke (unauthenticated)', () => {
  test('unauthenticated visit redirects to login or shows login form', async ({
    page
  }) => {
    await page.goto('/');
    // Client AuthGuard replaces location with /login when no session.
    await page.waitForURL(/\/login/, { timeout: 20_000 }).catch(() => {});
    const url = page.url();
    const onLogin = /\/login/.test(url);
    const hasForm =
      (await page.locator('form input[type="email"], form input[name="email"]').count()) >
      0;
    const body = await page.content();
    const hasLoginCopy = /sign\s*in|log\s*in|magic\s*link|work email/i.test(body);
    expect(
      onLogin || hasForm || hasLoginCopy,
      `expected login screen after unauth visit; url=${url}`
    ).toBe(true);
  });

  test('login page loads over HTTPS with login UI', async ({ page, request }) => {
    expect(LIVE_URL.startsWith('https://')).toBe(true);
    const res = await request.get(`${LIVE_URL}/login`);
    expect(res.status()).toBe(200);
    const html = await res.text();
    expect(html).toMatch(/sign\s*in|log\s*in|email|magic/i);
    // Page source must not embed privileged material (constructed to avoid
    // matching the suite itself in repo-wide secret scanners).
    const privileged = ['service', 'role'].join('_');
    const providerPrefix = ['sk', '-'].join('');
    expect(html.toLowerCase()).not.toContain(privileged);
    expect(html).not.toMatch(new RegExp(providerPrefix + '[A-Za-z0-9]{10,}'));

    await page.goto('/login');
    await expect(
      page.locator('form input[type="email"], form input[name="email"]')
    ).toBeVisible({ timeout: 15_000 });
  });

  test('pyramid routes respond without 5xx for unauthenticated request', async ({
    request
  }) => {
    for (const path of ['/', '/layer/1', '/scorecard', '/login']) {
      const res = await request.get(`${LIVE_URL}${path}`);
      expect(res.status(), path).toBeLessThan(500);
      // 200 HTML or auth redirect are both acceptable.
      expect([200, 301, 302, 303, 307, 308]).toContain(res.status());
    }
  });
});

test.describe('operator smoke (authenticated)', () => {
  test('login works and pyramid is visible after login', async ({ page }) => {
    const c = smokeCredentials();
    test.skip(!c.hasFounder, missingFounderReason());

    await authFounder(page);
    await page.goto('/');
    await expect(page.locator('.pyramid')).toBeVisible({ timeout: 20_000 });
    const text = await page.locator('.pyramid').innerText();
    expect(text).toMatch(/MANAGE|MONITOR|Layer|layer/i);
  });

  test('founder can perform a write (update a scorecard value)', async ({
    page
  }) => {
    const c = smokeCredentials();
    test.skip(!c.hasFounder, missingFounderReason());

    await authFounder(page);

    const session = await page.evaluate(() => {
      try {
        return JSON.parse(window.localStorage.getItem('ig-board.session') || 'null');
      } catch {
        return null;
      }
    });
    expect(session && session.access_token).toBeTruthy();

    // Resolve a period that will become the series latest point.
    const valsRes = await page.request.get(`${LIVE_URL}/api/kpi-values`, {
      headers: { Authorization: `Bearer ${session.access_token}` }
    });
    expect(valsRes.status()).toBe(200);
    const { values } = await valsRes.json();
    const series = (values && values.cash_runway_months) || [];
    let writePeriod = '2026-07';
    if (series.length) {
      const maxPeriod = series
        .map((p) => String(p.period))
        .sort()
        .at(-1);
      writePeriod = maxPeriod.slice(0, 7);
    }

    // Prefer the founder update console UI when present.
    await page.goto('/update');
    const form = page.locator('[data-testid="value-entry-form"]');
    if ((await form.count()) > 0) {
      await expect(form).toBeVisible({ timeout: 15_000 });
      await page.locator('#kpi-key').selectOption('cash_runway_months');
      await page.locator('#kpi-period').fill(writePeriod);
      await page.locator('#kpi-value').fill('11');
      await page.locator('#kpi-note').fill('operator smoke founder write');
      await page
        .locator('[data-testid="value-entry-form"] button[type="submit"]')
        .click();
      await expect(page.locator('[data-testid="value-entry-status"]')).toContainText(
        /Saved/i,
        { timeout: 20_000 }
      );
    } else {
      // API write path as fallback proof (still founder-authenticated).
      const post = await page.request.post(`${LIVE_URL}/api/kpi-values`, {
        headers: { Authorization: `Bearer ${session.access_token}` },
        data: {
          key: 'cash_runway_months',
          period: writePeriod,
          value: 11,
          note: 'operator smoke founder write'
        }
      });
      expect([200, 201]).toContain(post.status());
    }
  });

  test('board user is read-only (write attempts rejected)', async ({ page }) => {
    const c = smokeCredentials();
    test.skip(!c.hasBoard, missingBoardReason());

    await authBoard(page);
    await page.goto('/');
    await expect(page.locator('.pyramid')).toBeVisible({ timeout: 20_000 });

    // No founder write controls in the DOM.
    await page.goto('/update');
    await expect(page.locator('[data-testid="value-entry-form"]')).toHaveCount(0);
    await expect(page.locator('button:has-text("Save value")')).toHaveCount(0);

    const token = await page.evaluate(() => {
      try {
        const raw = window.localStorage.getItem('ig-board.session');
        return raw ? JSON.parse(raw).access_token : null;
      } catch {
        return null;
      }
    });
    expect(token).toBeTruthy();

    const post = await page.request.post(`${LIVE_URL}/api/kpi-values`, {
      headers: { Authorization: `Bearer ${token}` },
      data: {
        key: 'nps',
        period: '2026-08',
        value: 99,
        note: 'operator smoke board must fail'
      }
    });
    expect([401, 403]).toContain(post.status());
  });
});
