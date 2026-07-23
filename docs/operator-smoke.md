# Operator smoke — 5-minute day-to-day path

Live app: **https://ig-board-production.up.railway.app**

This runbook is the short path an operator walks after a deploy (or each morning)
to confirm Boardroom is healthy. It does **not** require shell access. Secrets
never live in this repo — use invite-only accounts provisioned out of band
(see [`TESTING.md`](../TESTING.md) and [`docs/env.md`](env.md)).

---

## 5-minute path (ordered)

Do these steps in order. Target: under five minutes.

1. **Open the live URL**  
   In a browser, open  
   [https://ig-board-production.up.railway.app](https://ig-board-production.up.railway.app)  
   (or `/` on that host). You should land on the app shell; if you are not
   signed in, the client guard sends you to the login screen.

2. **Log in**  
   On `/login`, enter your invite-only work email and submit **Send magic link**.  
   Complete the link (self-hosted demo deploys may finish sign-in via an
   inline `action_link` without email delivery). You should leave `/login`
   and land on the home dashboard.

3. **See the pyramid scorecard**  
   On `/` after login, confirm the five-layer **pyramid** scorecard is visible
   (MANAGE / MONITOR bands, layer labels). Gray loading should clear to real
   RAG status once KPI values paint.

4. **Open a layer**  
   Click a pyramid band (or go to `/layer/1`) and confirm the layer detail
   loads with KPI cards (values, RAG chips, sparklines where seeded).

5. **As founder, update a value**  
   Sign in as a **founder** account (not board). Open a KPI (e.g.
   `/kpi/cash_runway_months`) or the founder **Update** console (`/update`).  
   Enter a numeric value for a period and save. Expect a success status and
   an audit trail row (who / when / old / new).  
   A **board** user must remain read-only: no value-entry form in the DOM, and
   write APIs return `403` (or `401` if unauthenticated).

If any step fails, check [Deploy flakes & troubleshooting](#deploy-flakes--troubleshooting)
before escalating.

---

## Automated smoke suite

In-repo Playwright smoke lives under `e2e/smoke.spec.js` (shared config:
`playwright.config.mjs`). It targets a **live** base URL — it does not start a
local server.

### Environment variables

| Variable | Required for | Purpose |
| -------- | ------------ | ------- |
| `LIVE_URL` | optional | Live base URL (default `https://ig-board-production.up.railway.app`). Alias: `PLAYWRIGHT_BASE_URL`. |
| `SMOKE_FOUNDER_EMAIL` | founder write tests | Founder invite email (magic-link path). |
| `SMOKE_FOUNDER_PASSWORD` | optional | Vault slot for founder credential material when password-style secrets are injected; unused for magic-link-only deploys. Prefer `SMOKE_FOUNDER_JWT` / `FOUNDER_JWT` for token injection. |
| `SMOKE_BOARD_EMAIL` | board read-only tests | Board invite email. |
| `SMOKE_BOARD_PASSWORD` | optional | Same as founder password slot for board. Prefer `SMOKE_BOARD_JWT` / `BOARD_JWT`. |
| `SMOKE_FOUNDER_JWT` / `FOUNDER_JWT` | alternative to email | Pre-minted access token; injects a session without OTP. |
| `SMOKE_BOARD_JWT` / `BOARD_JWT` | alternative to email | Board access token. |

**Never commit** emails paired with passwords, JWTs, privileged API keys, or
provider secret keys. Inject credentials via CI/Vault or your local shell only.

When founder/board credentials are absent, authenticated smoke cases **skip**
with a clear message (they do not crash). Unauthenticated checks (redirect to
login, public HTML) always run.

### How to run

```bash
# From repo root, with Playwright browsers installed once:
npx playwright install chromium   # first time only

# Public + unauth checks only (no credentials):
npm run test:smoke

# Full smoke including founder write + board denial:
export LIVE_URL=https://ig-board-production.up.railway.app
export SMOKE_FOUNDER_EMAIL=...   # invite-only founder from vault
export SMOKE_BOARD_EMAIL=...     # invite-only board from vault
# Optional token path (skips magic-link OTP):
# export SMOKE_FOUNDER_JWT=... SMOKE_BOARD_JWT=...
npm run test:smoke
```

What the suite covers:

1. Unauthenticated visit → login screen (redirect or login form).
2. Login works (magic link or JWT session).
3. Pyramid visible after login.
4. Founder can write a scorecard KPI value.
5. Board is read-only (write attempts rejected).

Related non-browser probe: `scripts/live-check.sh` (health, version, 401
regression). See also phase Playwright suites under `e2e/phase*.spec.js`.

---

## Deploy flakes & troubleshooting

Use this when a Railway deploy looks **stuck**, **stale**, or the UI does not
match `main`.

### 1. Compare `/version` to `main` SHA

```bash
# What production claims to be running:
curl -fsS https://ig-board-production.up.railway.app/version
# -> {"sha":"<40-char git sha>", ...}

# What GitHub main tip is:
git ls-remote https://github.com/southu/ig-board.git main
```

- If live `sha` **matches** `main` but the UI looks wrong, the problem is app
  logic or data — not a missed deploy.
- If live `sha` is **behind** `main`, the auto-deploy has not finished, failed,
  or rolled back. Check Railway deploy logs for the `api` service.

### 2. Check `/health` (and optionally `/ready`)

```bash
curl -fsS -o /dev/null -w '%{http_code}\n' \
  https://ig-board-production.up.railway.app/health   # expect 200

curl -fsS https://ig-board-production.up.railway.app/ready
# booleans only — jwt_secret_set, supabase_url_set, supabase_key_set, db_reachable
```

- `/health` **not** 200 → process down or proxy issue; open Railway metrics/logs.
- `/health` 200 but `/ready` has `false` checks → vault env incomplete (see
  [`DEPLOY.md`](../DEPLOY.md) and [`docs/env.md`](env.md)); login may fail closed.
- `/version` still serving an old SHA with `/health` 200 → deploy never flipped
  traffic; force a redeploy (below).

### 3. Redeploy steps

1. Confirm the intended commit is on `main` and CI/history is clean.  
2. **Preferred:** push an empty commit or a real fix to `main` so GitHub
   auto-deploy rebuilds the Railway `api` service.  
3. **Fallback:** from a clean checkout of `main`, run
   `scripts/deploy-railway.sh` (needs `RAILWAY_API_TOKEN` from the vault —
   never commit it). See [`DEPLOY.md`](../DEPLOY.md).  
4. Wait for Railway healthcheck on `/health`, then re-check `/version` until
   the SHA matches the tip you deployed.  
5. Re-run this 5-minute path (or `npm run test:smoke`).

### Quick decision table

| Symptom | Check | Likely action |
| ------- | ----- | ------------- |
| Blank/error page | `/health` | Railway restart / logs |
| Old UI after merge | `/version` vs `main` | Wait or redeploy |
| Login unavailable | `/ready`, `GET /config` | Bind JWT/auth env from vault |
| Board can write | smoke + `/api/kpi-values` | Role mapping / RLS — do not weaken |

---

## Related docs

- [`TESTING.md`](../TESTING.md) — live endpoints, test users, JWT mint paths  
- [`DEPLOY.md`](../DEPLOY.md) — Railway wiring, auto-deploy on `main`  
- [`docs/env.md`](env.md) — env var **names** only (no secret values)  
