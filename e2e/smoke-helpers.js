// Credential + session helpers for the operator live smoke suite (e2e/smoke.spec.js).
// All credentials are read from environment variables only. Never hardcode
// passwords, tokens, or email+password pairs. See docs/operator-smoke.md.

export const LIVE_URL = (
  process.env.LIVE_URL ||
  process.env.PLAYWRIGHT_BASE_URL ||
  'https://ig-board-production.up.railway.app'
).replace(/\/+$/, '');

// Read smoke credentials exclusively from the environment (CI/Vault/operator shell).
// Password slots are accepted for vault templates; Boardroom production sign-in
// is magic-link (or injected JWT) — passwords are not sent to a password grant.
export function smokeCredentials() {
  const founderEmail = (process.env.SMOKE_FOUNDER_EMAIL || '').trim();
  const founderPassword = process.env.SMOKE_FOUNDER_PASSWORD || '';
  const boardEmail = (process.env.SMOKE_BOARD_EMAIL || '').trim();
  const boardPassword = process.env.SMOKE_BOARD_PASSWORD || '';
  const founderJwt = (
    process.env.SMOKE_FOUNDER_JWT ||
    process.env.FOUNDER_JWT ||
    ''
  ).trim();
  const boardJwt = (
    process.env.SMOKE_BOARD_JWT ||
    process.env.BOARD_JWT ||
    ''
  ).trim();

  // Touch password env keys so vault-injected secrets are acknowledged even when
  // the magic-link path does not use them (avoids "unused secret" confusion).
  void founderPassword;
  void boardPassword;

  return {
    founderEmail,
    founderPassword,
    boardEmail,
    boardPassword,
    founderJwt,
    boardJwt,
    hasFounder: Boolean(founderJwt || founderEmail),
    hasBoard: Boolean(boardJwt || boardEmail)
  };
}

export function missingFounderReason() {
  return (
    'Skipping founder smoke: set SMOKE_FOUNDER_EMAIL (magic-link) or ' +
    'SMOKE_FOUNDER_JWT / FOUNDER_JWT (token inject). Optional: SMOKE_FOUNDER_PASSWORD.'
  );
}

export function missingBoardReason() {
  return (
    'Skipping board smoke: set SMOKE_BOARD_EMAIL (magic-link) or ' +
    'SMOKE_BOARD_JWT / BOARD_JWT (token inject). Optional: SMOKE_BOARD_PASSWORD.'
  );
}

// Inject a pre-minted access_token into localStorage (no OTP round-trip).
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
  await page.waitForSelector('.pyramid, .route-guard', { timeout: 20_000 });
  if (await page.locator('.route-guard').count()) {
    await page.waitForSelector('.pyramid', { timeout: 20_000 });
  }
}

// Complete magic-link sign-in for an invite-only email via the live OTP path
// (inline action_link when no external mailer is bound).
export async function signInWithEmail(page, email) {
  const config = await page.request.get(`${LIVE_URL}/config`);
  if (!config.ok()) {
    throw new Error(`GET /config failed: ${config.status()}`);
  }
  const { supabaseUrl, supabaseAnonKey } = await config.json();
  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error(
      'loginConfig empty — cannot sign in (check /ready and vault auth env)'
    );
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
        email_redirect_to: `${LIVE_URL}/`
      }
    }
  });
  if (!otp.ok()) {
    throw new Error(`OTP request failed: ${otp.status()} ${await otp.text()}`);
  }
  const body = await otp.json();
  if (!body || typeof body.action_link !== 'string') {
    throw new Error(
      'No inline action_link — magic-link is email-only on this deploy; ' +
        'use SMOKE_FOUNDER_JWT / SMOKE_BOARD_JWT instead'
    );
  }
  await page.goto(body.action_link);
  await page.waitForURL(/\/($|\?)/, { timeout: 20_000 });
  await page.waitForSelector('.pyramid, .route-guard', { timeout: 20_000 });
  if (await page.locator('.route-guard').count()) {
    await page.waitForSelector('.pyramid', { timeout: 20_000 });
  }
}

export async function authFounder(page) {
  const c = smokeCredentials();
  if (c.founderJwt) {
    await injectSession(page, c.founderJwt);
    return;
  }
  if (!c.founderEmail) {
    throw new Error(missingFounderReason());
  }
  await signInWithEmail(page, c.founderEmail);
}

export async function authBoard(page) {
  const c = smokeCredentials();
  if (c.boardJwt) {
    await injectSession(page, c.boardJwt);
    return;
  }
  if (!c.boardEmail) {
    throw new Error(missingBoardReason());
  }
  await signInWithEmail(page, c.boardEmail);
}
