// Capture the eight Phase 4 screenshots (dashboard + layer × light/dark × desktop/375)
// against a running app (default: local :8099). Auth via self-hosted magic link.
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = (process.env.LIVE_URL || 'http://127.0.0.1:8099').replace(/\/+$/, '');
const EMAIL = process.env.BOARD_TEST_EMAIL || 'board.e2e@boardroom.test';
const OUT = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'docs',
  'screenshots',
  'phase4'
);

mkdirSync(OUT, { recursive: true });

async function signIn(page) {
  const config = await page.request.get(`${BASE}/config`);
  if (!config.ok()) throw new Error(`GET /config ${config.status()}`);
  const { supabaseUrl, supabaseAnonKey } = await config.json();
  const otp = await page.request.post(`${supabaseUrl}/auth/v1/otp`, {
    headers: {
      'Content-Type': 'application/json',
      apikey: supabaseAnonKey
    },
    data: {
      email: EMAIL,
      create_user: false,
      options: { email_redirect_to: `${BASE}/` }
    }
  });
  if (!otp.ok()) throw new Error(`OTP ${otp.status()} ${await otp.text()}`);
  const body = await otp.json();
  if (!body.action_link) throw new Error('no action_link');
  await page.goto(body.action_link);
  await page.waitForSelector('.pyramid', { timeout: 30_000 });
}

async function forceTheme(page, theme) {
  await page.evaluate((t) => {
    localStorage.setItem('ig-board.theme', t);
    document.documentElement.setAttribute('data-theme', t);
  }, theme);
}

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

const browser = await chromium.launch();
const page = await browser.newPage();
await signIn(page);

for (const s of shots) {
  await page.setViewportSize({ width: s.w, height: s.h });
  await page.goto(`${BASE}${s.path}`);
  await forceTheme(page, s.theme);
  await page.goto(`${BASE}${s.path}`);
  await page.waitForTimeout(400);
  const dest = join(OUT, s.file);
  await page.screenshot({ path: dest, fullPage: true });
  console.log('wrote', dest);
}

await browser.close();
console.log('done — 8 screenshots in', OUT);
