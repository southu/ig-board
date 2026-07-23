// Phase 2 Playwright suite — Independent Analysis (AI-generated) live acceptance.
// Targets LIVE_URL / PLAYWRIGHT_BASE_URL (default: production Railway).
//
// Covers:
//   * exact page label in light + dark
//   * five section headings in order
//   * at least one real KPI name + value cited
//   * documented failure-simulation trigger → retry state → successful retry
//   * analysis network call targets Fastify /api/independent-analysis (not Next)
//   * no sk-ant / api.anthropic.com in browser-served HTML/JS assets
import { test, expect } from '@playwright/test';
import { authAs } from './helpers.js';

const LIVE = (
  process.env.PLAYWRIGHT_BASE_URL ||
  process.env.LIVE_URL ||
  'https://ig-board-production.up.railway.app'
).replace(/\/+$/, '');

const LABEL = 'Independent Analysis (AI-generated)';
const SECTIONS = [
  'Summary',
  'Claims vs Scorecard',
  'Slippage Watch',
  'Attribution Watch',
  'Questions the Board Should Ask'
];

// Real seeded KPI names the offline/live analysis is expected to cite.
const KPI_NAME_RE =
  /Cash Runway \(months\)|Gross Margin %|EBITDA Margin %|Net Promoter Score|Revenue Plan FY1/;
const KPI_VALUE_RE = /\b\d+(\.\d+)?\b/;

test.describe.configure({ mode: 'serial' });

test('analysis page returns HTTP 200', async ({ request }) => {
  const res = await request.get(`${LIVE}/analysis`);
  expect(res.status()).toBe(200);
  const ct = res.headers()['content-type'] || '';
  expect(ct).toMatch(/text\/html/i);
});

test('no sk-ant or api.anthropic.com in browser-served HTML/JS assets', async ({
  request
}) => {
  // Spot-check the analysis HTML shell and a handful of static JS chunks.
  const paths = ['/analysis', '/analysis.html', '/'];
  const html = await request.get(`${LIVE}/analysis`);
  expect(html.status()).toBe(200);
  const htmlText = await html.text();
  expect(htmlText).not.toMatch(/sk-ant/);
  expect(htmlText).not.toMatch(/api\.anthropic\.com/);

  // Collect script srcs from the page and scan them.
  const scriptSrcs = [
    ...htmlText.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)
  ].map((m) => m[1]);
  const toCheck = scriptSrcs.slice(0, 12);
  for (const src of toCheck) {
    const url = src.startsWith('http')
      ? src
      : `${LIVE}${src.startsWith('/') ? '' : '/'}${src}`;
    // Only scan same-origin assets.
    if (!url.startsWith(LIVE)) continue;
    const res = await request.get(url);
    if (!res.ok()) continue;
    const body = await res.text();
    expect(body, src).not.toMatch(/sk-ant-[a-zA-Z0-9_-]{8,}/);
    expect(body, src).not.toMatch(/api\.anthropic\.com/);
  }
  // Silence unused
  void paths;
});

test('label visible in light theme; five sections; KPI cite; Fastify network target', async ({
  page
}) => {
  await authAs(page, 'founder');

  // Force light theme before analysis.
  await page.goto('/');
  await page.evaluate(() => {
    localStorage.setItem('ig-board.theme', 'light');
    document.documentElement.setAttribute('data-theme', 'light');
  });

  const analysisRequests = [];
  page.on('request', (req) => {
    // Match the Fastify analysis route only — not comment filters that carry
    // analysis_id=independent-analysis as a query param (those are GETs).
    try {
      const u = new URL(req.url());
      if (u.pathname === '/api/independent-analysis') {
        analysisRequests.push({
          url: req.url(),
          method: req.method()
        });
      }
    } catch {
      // ignore malformed
    }
  });

  await page.goto('/analysis');
  await expect(page.locator('[data-testid="analysis-page-label"]')).toHaveText(
    LABEL
  );
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');

  // Wait for successful analysis body (offline or Anthropic).
  await expect(page.locator('[data-testid="analysis-body"]')).toBeVisible({
    timeout: 60_000
  });
  const bodyText = await page.locator('[data-testid="analysis-markdown"]').innerText();

  // Five headings in order.
  let last = -1;
  for (const h of SECTIONS) {
    const idx = bodyText.indexOf(h);
    expect(idx, `missing section ${h}`).toBeGreaterThanOrEqual(0);
    expect(idx, `section ${h} out of order`).toBeGreaterThan(last);
    last = idx;
  }

  // At least one real KPI name + a numeric value.
  expect(bodyText).toMatch(KPI_NAME_RE);
  expect(bodyText).toMatch(KPI_VALUE_RE);

  // Network call targeted Fastify /api/independent-analysis (not a Next route
  // under a different host, and not api.anthropic.com).
  expect(analysisRequests.length).toBeGreaterThan(0);
  for (const r of analysisRequests) {
    expect(r.method).toBe('POST');
    expect(r.url).toMatch(/\/api\/independent-analysis/);
    expect(r.url).not.toMatch(/api\.anthropic\.com/);
    // Same origin as the live app.
    expect(r.url.startsWith(LIVE)).toBe(true);
  }
});

test('label visible in dark theme', async ({ page }) => {
  await authAs(page, 'board');
  await page.goto('/');
  await page.evaluate(() => {
    localStorage.setItem('ig-board.theme', 'dark');
    document.documentElement.setAttribute('data-theme', 'dark');
  });
  await page.goto('/analysis');
  await expect(page.locator('[data-testid="analysis-page-label"]')).toHaveText(
    LABEL
  );
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.locator('[data-testid="analysis-body"]')).toBeVisible({
    timeout: 60_000
  });
});

test('documented failure simulation shows retry; retry succeeds after disable', async ({
  page
}) => {
  await authAs(page, 'founder');

  // Documented test-only trigger: ?simulate_anthropic_failure=1
  await page.goto('/analysis?simulate_anthropic_failure=1');
  await expect(page.locator('[data-testid="analysis-page-label"]')).toHaveText(
    LABEL
  );

  const retryState = page.locator('[data-testid="analysis-retry-state"]');
  await expect(retryState).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('[data-testid="analysis-retry"]')).toBeVisible();
  await expect(
    page.locator('[data-testid="analysis-error-message"]')
  ).toContainText(/Simulated|simulate|unavailable|fail/i);

  // Retry disables simulation and produces a successful analysis.
  await page.locator('[data-testid="analysis-retry"]').click();
  await expect(page.locator('[data-testid="analysis-body"]')).toBeVisible({
    timeout: 60_000
  });
  const bodyText = await page.locator('[data-testid="analysis-markdown"]').innerText();
  for (const h of SECTIONS) {
    expect(bodyText, h).toContain(h);
  }
  expect(bodyText).toMatch(KPI_NAME_RE);
});
