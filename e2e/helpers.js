// Shared helpers for the Phase 1 Playwright suite. Auth uses the live self-hosted
// magic-link path (inline action_link when no mailer is bound) so no secrets,
// passwords, or service-role keys are needed in the suite.

export const FOUNDER_EMAIL =
  process.env.FOUNDER_TEST_EMAIL || 'founder.e2e@boardroom.test';
export const BOARD_EMAIL =
  process.env.BOARD_TEST_EMAIL || 'board.e2e@boardroom.test';

// Complete a magic-link sign-in for `email` in the given page context and land
// on `/`. Relies on the self-hosted OTP endpoint returning an inline action_link
// (the live demo path with no external mailer).
export async function signIn(page, email) {
  const config = await page.request.get('/config');
  if (!config.ok()) throw new Error(`GET /config failed: ${config.status()}`);
  const { supabaseUrl, supabaseAnonKey } = await config.json();
  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error('loginConfig empty — cannot sign in');
  }

  const otp = await page.request.post(`${supabaseUrl}/auth/v1/otp`, {
    headers: {
      'Content-Type': 'application/json',
      apikey: supabaseAnonKey
    },
    data: {
      email,
      create_user: false,
      options: {
        email_redirect_to: new URL('/', page.url() || process.env.PLAYWRIGHT_BASE_URL || 'https://ig-board-production.up.railway.app').toString()
      }
    }
  });
  if (!otp.ok()) {
    throw new Error(`OTP request failed: ${otp.status()} ${await otp.text()}`);
  }
  const body = await otp.json();
  if (!body || typeof body.action_link !== 'string') {
    throw new Error(
      'No inline action_link returned — magic-link delivery is email-only on this deploy'
    );
  }
  await page.goto(body.action_link);
  // captureCallbackSession stores the hash tokens; wait until the pyramid is up.
  await page.waitForURL(/\/($|\?)/, { timeout: 20_000 });
  await page.waitForSelector('.pyramid, .route-guard', { timeout: 20_000 });
  // If we still see the guard, give the session a moment to settle.
  if (await page.locator('.route-guard').count()) {
    await page.waitForSelector('.pyramid', { timeout: 20_000 });
  }
}

// Seed a session into localStorage from a minted access_token (used when the
// suite has FOUNDER_JWT / BOARD_JWT from the offline mint path).
export async function injectSession(page, accessToken) {
  await page.goto('/login');
  await page.evaluate((token) => {
    const expiresAt = Math.floor(Date.now() / 1000) + 3600;
    window.localStorage.setItem(
      'ig-board.session',
      JSON.stringify({
        access_token: token,
        refresh_token: null,
        expires_at: expiresAt
      })
    );
  }, accessToken);
  await page.goto('/');
  await page.waitForSelector('.pyramid', { timeout: 20_000 });
}

export async function authAs(page, role) {
  const envToken =
    role === 'founder' ? process.env.FOUNDER_JWT : process.env.BOARD_JWT;
  if (envToken) {
    await injectSession(page, envToken);
    return;
  }
  const email = role === 'founder' ? FOUNDER_EMAIL : BOARD_EMAIL;
  await signIn(page, email);
}
