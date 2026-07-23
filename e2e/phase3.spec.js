// Phase 3 Playwright suite — Board Agenda generator live acceptance.
// Targets LIVE_URL / PLAYWRIGHT_BASE_URL (default: production Railway).
//
// Covers:
//   * GET /agenda HTTP 200 (static shell)
//   * time-blocked topics from red/yellow KPIs, unresolved comments, analysis questions
//   * ordering: Leadership Alignment (layer 1) before Revenue Growth / Enterprise Value
//   * edited_content persists; generated original intact
//   * regenerate does not overwrite edited_content
//   * unresolved comment appears; resolved does not after regenerate
//   * home + analysis still HTTP 200 (regression)
import { test, expect } from '@playwright/test';
import { authAs } from './helpers.js';

const LIVE = (
  process.env.PLAYWRIGHT_BASE_URL ||
  process.env.LIVE_URL ||
  'https://ig-board-production.up.railway.app'
).replace(/\/+$/, '');

const MARKER = `PHASE3_AGENDA_COMMENT_${Date.now()}`;
const EDIT_MARKER = `PHASE3_EDITED_CONTENT_${Date.now()}`;

test.describe.configure({ mode: 'serial' });

test('agenda + home + analysis pages return HTTP 200', async ({ request }) => {
  for (const path of ['/agenda', '/', '/analysis']) {
    const res = await request.get(`${LIVE}${path}`);
    expect(res.status(), path).toBe(200);
    const ct = res.headers()['content-type'] || '';
    expect(ct).toMatch(/text\/html/i);
  }
});

test('agenda API returns time-blocked multi-source topics; layer 1 before high layers', async ({
  page
}) => {
  await authAs(page, 'founder');

  // Exercise the page UI load path.
  await page.goto('/agenda');
  await expect(page.locator('[data-testid="agenda-page"]')).toBeVisible({
    timeout: 30_000
  });
  await expect(page.locator('[data-testid="agenda-topics"]')).toBeVisible({
    timeout: 60_000
  });

  const sections = page.locator('[data-testid="agenda-layer-section"]');
  await expect(sections).toHaveCount(5);
  await expect(page.locator('[data-testid="agenda-layer-heading"]')).toHaveText([
    'Layer 1 Leadership Alignment',
    'Layer 2 Management Systems',
    'Layer 3 Capabilities & Execution',
    'Layer 4 Revenue Growth',
    'Layer 5 Enterprise Value'
  ]);
  await expect(sections.nth(1).locator('[data-testid="agenda-kpi-item"]')).toHaveText([
    /2\.1.*Role Clarity Score/,
    /2\.2.*Survey Response Rate/,
    /2\.3.*Success-Criteria Coverage/
  ]);
  await expect(sections.nth(1).locator('[data-testid="agenda-watch-item"]')).toContainText(
    'Six-Month Rule — Pilot Hire'
  );

  const topics = page.locator('[data-testid="agenda-topic"]');
  await expect(topics.first()).toBeVisible({ timeout: 30_000 });
  const count = await topics.count();
  expect(count).toBeGreaterThan(0);

  // Every topic has a time block.
  for (let i = 0; i < count; i++) {
    const block = topics.nth(i).locator('[data-testid="agenda-time-block"]');
    await expect(block).toBeVisible();
    const text = (await block.innerText()).trim();
    expect(text).toMatch(/\d{2}:\d{2}/);
  }

  // Sources summary mentions KPIs / comments / questions (or zeros after empty).
  const sources = page.locator('[data-testid="agenda-sources"]');
  await expect(sources).toBeVisible();
  const sourcesText = await sources.innerText();
  expect(sourcesText).toMatch(/KPI/i);
  expect(sourcesText).toMatch(/comment/i);
  expect(sourcesText).toMatch(/question/i);

  // Ordering via data attributes on topics.
  const layerNames = await topics.evaluateAll((els) =>
    els.map((el) => el.getAttribute('data-layer-name') || '')
  );
  const layers = await topics.evaluateAll((els) =>
    els.map((el) => Number(el.getAttribute('data-layer') || '0'))
  );
  // Non-decreasing layer positions (bottom-up pyramid).
  for (let i = 1; i < layers.length; i++) {
    expect(layers[i]).toBeGreaterThanOrEqual(layers[i - 1]);
  }
  const firstLa = layerNames.findIndex((n) => n === 'Leadership Alignment');
  const firstRev = layerNames.findIndex((n) => n === 'Revenue Growth');
  const firstEv = layerNames.findIndex((n) => n === 'Enterprise Value');
  // With seeded red/yellow financial KPIs we always expect Leadership Alignment.
  expect(firstLa).toBeGreaterThanOrEqual(0);
  if (firstRev >= 0) expect(firstLa).toBeLessThan(firstRev);
  if (firstEv >= 0) expect(firstLa).toBeLessThan(firstEv);

  // At least one KPI-sourced topic from the current scorecard seed.
  const sourcesAttr = await topics.evaluateAll((els) =>
    els.map((el) => el.getAttribute('data-source') || '')
  );
  expect(sourcesAttr.some((s) => s === 'kpi')).toBe(true);
  // Analysis questions feed the agenda.
  expect(sourcesAttr.some((s) => s === 'analysis_question')).toBe(true);
});

test('edit persists edited_content; generated original remains; regen keeps edit', async ({
  page
}) => {
  await authAs(page, 'founder');
  await page.goto('/agenda');
  await expect(page.locator('[data-testid="agenda-topics"]')).toBeVisible({
    timeout: 60_000
  });

  // Capture a slice of generated original before edit.
  await page.locator('[data-testid="agenda-generated-summary"]').click();
  const generatedBefore = await page
    .locator('[data-testid="agenda-generated-content"]')
    .innerText();
  expect(generatedBefore.length).toBeGreaterThan(20);
  expect(generatedBefore).toMatch(/topics/i);

  // Founder edits.
  const editor = page.locator('[data-testid="agenda-edited-content"]');
  await editor.fill(EDIT_MARKER + '\n\nBoard notes for this meeting.');
  await page.locator('[data-testid="agenda-save-edit"]').click();
  await expect(page.locator('[data-testid="agenda-has-edited"]')).toBeVisible({
    timeout: 20_000
  });

  // Refetch via reload — edit and generated both present.
  await page.reload();
  await expect(page.locator('[data-testid="agenda-topics"]')).toBeVisible({
    timeout: 60_000
  });
  await expect(page.locator('[data-testid="agenda-edited-content"]')).toHaveValue(
    new RegExp(EDIT_MARKER)
  );
  await page.locator('[data-testid="agenda-generated-summary"]').click();
  const generatedAfterEdit = await page
    .locator('[data-testid="agenda-generated-content"]')
    .innerText();
  // Generated original still has topics structure (not replaced by the edit marker).
  expect(generatedAfterEdit).toMatch(/topics/i);
  expect(generatedAfterEdit).not.toContain(EDIT_MARKER);

  // Regenerate must keep edited_content.
  await page.locator('[data-testid="agenda-regenerate"]').click();
  await expect(page.locator('[data-testid="agenda-topics"]')).toBeVisible({
    timeout: 60_000
  });
  await expect(page.locator('[data-testid="agenda-edited-content"]')).toHaveValue(
    new RegExp(EDIT_MARKER)
  );
  await expect(page.locator('[data-testid="agenda-has-edited"]')).toBeVisible();
});

test('unresolved comment appears as topic; resolved does not after regenerate', async ({
  page
}) => {
  await authAs(page, 'founder');

  // Create an unresolved comment on a seeded KPI via API (same origin session).
  const session = await page.evaluate(() => {
    try {
      return JSON.parse(window.localStorage.getItem('ig-board.session') || 'null');
    } catch {
      return null;
    }
  });
  expect(session && session.access_token).toBeTruthy();

  const createRes = await page.request.post(`${LIVE}/api/comments`, {
    headers: {
      Authorization: `Bearer ${session.access_token}`,
      'Content-Type': 'application/json'
    },
    data: {
      body: `${MARKER} — please discuss at the board meeting`,
      kpi_id: 'bypass_count'
    }
  });
  expect(createRes.status()).toBe(201);
  const created = await createRes.json();
  const commentId = created.comment && created.comment.id;
  expect(commentId).toBeTruthy();

  // Regenerate agenda so the comment is picked up.
  await page.goto('/agenda');
  await expect(page.locator('[data-testid="agenda-page"]')).toBeVisible({
    timeout: 30_000
  });
  await page.locator('[data-testid="agenda-regenerate"]').click();
  await expect(page.locator('[data-testid="agenda-topics"]')).toBeVisible({
    timeout: 60_000
  });

  // Unresolved comment appears.
  const openTopic = page.locator(
    `[data-testid="agenda-topic"][data-comment-id="${commentId}"]`
  );
  await expect(openTopic).toBeVisible({ timeout: 15_000 });
  await expect(openTopic).toContainText(MARKER);

  // Resolve the comment.
  const resolveRes = await page.request.patch(`${LIVE}/api/comments/${commentId}`, {
    headers: {
      Authorization: `Bearer ${session.access_token}`,
      'Content-Type': 'application/json'
    },
    data: { resolved: true }
  });
  expect(resolveRes.status()).toBe(200);

  // Regenerate again — resolved comment must not appear.
  await page.locator('[data-testid="agenda-regenerate"]').click();
  await expect(page.locator('[data-testid="agenda-topics"]')).toBeVisible({
    timeout: 60_000
  });
  await expect(
    page.locator(`[data-testid="agenda-topic"][data-comment-id="${commentId}"]`)
  ).toHaveCount(0);
  const allText = await page.locator('[data-testid="agenda-topics"]').innerText();
  expect(allText).not.toContain(MARKER);
});
