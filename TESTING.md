# Testing Boardroom live

How the live deployment (<https://ig-board-production.up.railway.app>) is
verified, and how the two invite-only Supabase test users are created.

**Operator day-to-day path:** the 5-minute manual walkthrough, deploy-flake notes
(`/version` vs `main`, `/health`, redeploy), and automated smoke
(`npm run test:smoke`) live in **[`docs/operator-smoke.md`](docs/operator-smoke.md)**.

**No passwords, magic-link URLs, JWTs, or service-role keys appear in this repo.**
Secrets are supplied at runtime from the vault — see [`docs/env.md`](docs/env.md).

## Public endpoints (no auth)

```bash
curl -fsS https://ig-board-production.up.railway.app/health    # -> 200 {"status":"ok",...}
curl -fsS https://ig-board-production.up.railway.app/version   # -> 200 {"sha": "<origin/main HEAD>", ...}
curl -fsS https://ig-board-production.up.railway.app/ready     # -> 200 {"ready":true,"checks":{"jwt_secret_set":true,"supabase_url_set":true,"supabase_key_set":true,"db_reachable":true}}
```

**Readiness path:** `GET /ready` (public, no auth). It returns JSON with
**booleans only** — never secret values, key fragments, or connection strings.

| Check               | Meaning                                                                 |
| ------------------- | ----------------------------------------------------------------------- |
| `jwt_secret_set`    | `SUPABASE_JWT_SECRET` (or `JWT_SECRET`) is bound — `/me` can verify JWTs |
| `supabase_url_set`  | External `SUPABASE_URL` is bound, **or** self-host origin is available with a JWT secret (auth at this service) |
| `supabase_key_set`  | `SUPABASE_SERVICE_ROLE_KEY` is bound, **or** JWT secret is bound so keys can be minted for self-hosted auth |
| `db_reachable`      | `DATABASE_URL` TCP-reachable when set; when unset, the in-memory data path is available |

`ready` is `true` only when **every** check is `true`. Missing env flips the
matching check to `false` without crashing the process. `/ready` is the
non-secret way to confirm vault-provisioned env reached the Railway `api`
service before authenticated checks below.

To confirm the browser login config directly (BUG-1 acceptance):

```bash
curl -fsS https://ig-board-production.up.railway.app/config    # -> 200 {"supabaseUrl":"https://<ref>.supabase.co","supabaseAnonKey":"<jwt>"}; Cache-Control: no-store
```

Non-empty `supabaseUrl` (https) + `supabaseAnonKey` means the login page will
fire a real `POST {supabaseUrl}/auth/v1/otp` (with an `apikey` header) instead of
failing closed. Empty strings mean `SUPABASE_URL` is still unbound on the `api`
service — see [`docs/env.md`](docs/env.md) and [`DEPLOY.md`](DEPLOY.md).

### One-shot live smoke check

[`scripts/live-check.sh`](scripts/live-check.sh) bundles the health, version
(and, from a checkout, the `sha == origin/main` match), and auth-`401`
regression checks into one command. It is non-secret — it reads only the live
URL and any JWTs you export out of band, and prints no secret values:

```bash
scripts/live-check.sh                                  # public + 401 regression
FOUNDER_JWT=... BOARD_JWT=... scripts/live-check.sh     # also assert /me role mapping
```

## Auth boundary (regression)

```bash
# Missing / invalid token must fail closed with 401.
curl -s -o /dev/null -w '%{http_code}\n' \
  https://ig-board-production.up.railway.app/me                                   # -> 401
curl -s -o /dev/null -w '%{http_code}\n' \
  -H 'Authorization: Bearer garbage' \
  https://ig-board-production.up.railway.app/me                                   # -> 401
```

## Test users

### Ratchet live-verification accounts (admin area)

These two dedicated accounts are **seeded on every boot** (in-memory users store
and/or Postgres when `DATABASE_URL` is bound). They are the primary credentials
for the admin-area acceptance suite.

Auth is **invite-only magic link** (no password field on `/login`). On the
self-hosted production deploy the OTP API returns an inline `action_link` that
finishes sign-in without email delivery — that link **is** the credential.

| Username (handle) | Login email (enter on `/login`)   | Role       | Capabilities |
| ----------------- | --------------------------------- | ---------- | ------------ |
| `ratchet-admin`   | `ratchet-admin@boardroom.test`    | `admin`    | full, including `access_admin_area` |
| `ratchet-employee`| `ratchet-employee@boardroom.test` | `employee` | `input_kpi_data` only (no admin) |

**How to sign in on production:**

1. Open `https://ig-board-production.up.railway.app/login`
2. Enter the email from the table (e.g. `ratchet-admin@boardroom.test`)
3. Submit **Send magic link**
4. Follow the inline `action_link` from the OTP response (browser is redirected
   automatically by the login page when the server returns it)

**Programmatic sign-in (curl):**

```bash
# 1) Public config (anon apikey)
CFG=$(curl -fsS https://ig-board-production.up.railway.app/config)
ANON=$(printf '%s' "$CFG" | node -e "let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>console.log(JSON.parse(s).supabaseAnonKey))")

# 2) Request OTP for the admin test account → inline action_link
curl -fsS -X POST https://ig-board-production.up.railway.app/auth/v1/otp \
  -H "Content-Type: application/json" -H "apikey: $ANON" \
  -d '{"email":"ratchet-admin@boardroom.test","create_user":false}'
# → { "action_link": "https://…/auth/v1/verify?token=…", "delivery": "inline" }

# 3) Follow verify (sets session cookie + fragment token), then call APIs with
#    Authorization: Bearer <access_token> from the redirect fragment or cookie.
```

Admin area URL (server-gated by `access_admin_area`):

```
https://ig-board-production.up.railway.app/admin
```

The admin page includes a **KPI data management** section (capability-gated):

| Control | Capability | Endpoint |
| ------- | ---------- | -------- |
| Add KPI entry form | `input_kpi_data` | `POST /api/kpi-values` |
| Edit existing KPI value form | `input_kpi_data` | `POST /api/kpi-values` (upsert) |
| Edit KPI definition form | `edit_kpi_data` | `PUT /api/kpi-definitions/:key` |

UI visibility is driven only by the `capabilities` array from `GET /me` /
`GET /api/session` (same map as the route guards). A `board_member` session
never sees these forms (empty capabilities), and direct POST/PUT returns **403**.

**Login as admin (write KPI data):** `ratchet-admin@boardroom.test` or
`admin.e2e@boardroom.test` on `/login` → magic link / inline `action_link`.

**Login as board_member (read-only):** `board_member.e2e@boardroom.test` or
`board.e2e@boardroom.test` on `/login` → same magic-link flow. Confirm KPI
pages load with no add/edit form controls; API writes return 403.

Admin APIs (all require `access_admin_area`; non-admin / unauthenticated → 403/401):

| Method | Path | Purpose |
| ------ | ---- | ------- |
| `GET`  | `/api/admin` | Admin area metadata + five role names |
| `GET`  | `/api/admin/users` | List users with current roles |
| `POST` | `/api/admin/users` | Create/invite a user `{ email, full_name?, role }` |
| `PATCH`| `/api/admin/users/:id` | Edit user details and/or role |

Role changes take effect on the **affected user's next request** (role is
resolved from the users store per request, not only from the JWT).

### Legacy e2e / operator accounts

Two invite-only users also back older authenticated checks and the admin write /
board_member read-only acceptance suite. Emails are **non-secret placeholders**
— override them (see below) to point at real invite-capable inboxes you control.

**There are no shared passwords.** Auth is invite-only magic link. On the
self-hosted production deploy (no external mailer), the OTP API returns an
inline `action_link` that finishes sign-in without email delivery.

Public directory on the live app (emails/roles only, no secrets):

```
GET https://ig-board-production.up.railway.app/test-accounts
```

| Role          | Email (default placeholder)         | `app_metadata.role` | `/me` or `/api/session`                         | KPI write |
| ------------- | ----------------------------------- | ------------------- | ----------------------------------------------- | --------- |
| Admin (ratchet) | `ratchet-admin@boardroom.test`    | `admin`             | `role: admin` + full `capabilities` list        | yes |
| Employee (ratchet) | `ratchet-employee@boardroom.test` | `employee`       | `role: employee` + `input_kpi_data`             | yes (input only) |
| Admin         | `admin.e2e@boardroom.test`          | `admin`             | `role: admin` + full `capabilities` list        | yes (`POST /api/kpi-values`) |
| Board member  | `board_member.e2e@boardroom.test`   | `board_member`      | `role: board_member` + empty `capabilities`     | no (API **403**) |

Env overrides (also accepted for backward compatibility):

| Env                         | Role          | Falls back to                          |
| --------------------------- | ------------- | -------------------------------------- |
| `ADMIN_TEST_EMAIL`          | admin         | `FOUNDER_TEST_EMAIL`, then default     |
| `BOARD_MEMBER_TEST_EMAIL`   | board_member  | `BOARD_TEST_EMAIL`, then default       |
| `FOUNDER_TEST_EMAIL`        | admin         | (legacy alias)                         |
| `BOARD_TEST_EMAIL`          | board_member  | (legacy alias)                         |

How a browser tester signs in: open `/login`, enter the email above, complete
the magic link (or follow the inline `action_link` from OTP on self-host).

### Role → capability map (single source of truth)

All server-side permission checks derive from
[`apps/api/src/permissions.js`](apps/api/src/permissions.js):

| Role          | Capabilities |
| ------------- | ------------ |
| `admin`       | `input_kpi_data`, `edit_kpi_data`, `delete_any_comment`, `access_admin_area` |
| `executive`   | `input_kpi_data`, `edit_kpi_data` |
| `employee`    | `input_kpi_data` |
| `consultant`  | `input_kpi_data` |
| `board_member`| _(none of the four — read-only + commenting/reactions)_ |

Legacy JWT roles `founder` / `board` alias to `admin` / `board_member` for
capability resolution and are canonicalized on `/me` and `/api/session`.

Session exposure (authenticated):

```bash
curl -fsS -H "Authorization: Bearer $TOKEN" \
  https://ig-board-production.up.railway.app/api/session
# -> { "id", "role", "email", "capabilities": [...] }
# GET /me returns the same shape.
```

The API reads the role from the JWT's `app_metadata.role`
(`apps/api/src/auth.js` → `extractRole`), and RLS resolves it from
`public.users.role`. The seed path below sets **both** so the two stay
consistent.

### How operators create them (documented admin/seed path)

Run the idempotent admin script with the service-role key from the vault. The
key is read from the environment only and is never printed or stored:

```bash
export SUPABASE_URL=https://<ref>.supabase.co
export SUPABASE_SERVICE_ROLE_KEY=<service-role-key-from-vault>   # never commit this
# Optional: use real inboxes instead of the placeholders.
# export ADMIN_TEST_EMAIL=admin+e2e@yourdomain.com
# export BOARD_MEMBER_TEST_EMAIL=board+e2e@yourdomain.com
# Legacy aliases still work:
# export FOUNDER_TEST_EMAIL=...
# export BOARD_TEST_EMAIL=...

npm run seed:test-users        # alias for: node scripts/create-test-users.mjs
```

The script (`scripts/create-test-users.mjs`) for each user:

1. Creates the Supabase **auth** user **without a password** (invite-only — they
   sign in later with a magic link / OTP), with `email_confirm: true`.
2. Sets `app_metadata.role` to `admin` / `board_member` so the issued JWT carries
   the app role the API reads.
3. Upserts the matching `public.users` row (`id` = auth user id) so RLS resolves
   the role. Idempotent — safe to re-run.

Equivalent manual path (Supabase dashboard): **Authentication → Users → Add
user** for each email, then edit the user's **App Metadata** to `{"role":
"admin"}` / `{"role": "board_member"}`, and insert the matching `public.users`
row with the same `id`, `email`, and `role`.

### Obtaining a JWT for the authenticated check

Two documented paths yield an `access_token` for a test user. Either way the
token is a short-lived **secret**: use it only in the shell for the check below;
**never commit or log it.**

**a) Scriptable, no browser (preferred for CI/live checks).**
[`scripts/mint-test-jwt.mjs`](scripts/mint-test-jwt.mjs) mints a token entirely
server-side with the service-role key: it calls the admin `generate_link`
endpoint for the (passwordless, invite-only) user and completes `verify` to get a
session. The service-role key is read from the environment only and never
printed; the minted token goes to **stdout only** for immediate capture.

```bash
export SUPABASE_URL=https://<ref>.supabase.co
export SUPABASE_SERVICE_ROLE_KEY=<service-role-key-from-vault>   # never commit

FOUNDER_JWT="$(npm run --silent mint:test-jwt -- --founder)"   # or: node scripts/mint-test-jwt.mjs --founder
BOARD_JWT="$(npm run --silent mint:test-jwt -- --board)"       # or an explicit address you control
FOUNDER_JWT="$FOUNDER_JWT" BOARD_JWT="$BOARD_JWT" scripts/live-check.sh   # asserts /me role mapping
```

Or, in one command: with just `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`
exported, `scripts/live-check.sh` mints both JWTs itself (via this same script)
and runs the founder/board `/me` role assertions — the minted tokens live only in
that process and are never printed or stored:

```bash
export SUPABASE_URL=https://<ref>.supabase.co
export SUPABASE_SERVICE_ROLE_KEY=<service-role-key-from-vault>   # never commit
scripts/live-check.sh                                  # public + 401 + founder/board /me roles
```

**a2) Offline, from the JWT secret only (no Supabase project needed).**
[`scripts/mint-jwt-offline.mjs`](scripts/mint-jwt-offline.mjs) signs a
Supabase-shaped HS256 token directly with `SUPABASE_JWT_SECRET` — the very secret
the API verifies against (`/ready` reports it as `jwt_secret_set: true`). It needs no
reachable Supabase project or service-role key and no `npm install` (Node
built-in `crypto` only), so the live `/me` role check works as soon as the JWT
secret is provisioned, even before an external admin path is bound. The token
carries `app_metadata.role` (`founder`/`board`) — exactly what `/me` reads — and a
stable placeholder `sub` (the check asserts the **role**, not the id). The secret
is read from the environment only and never printed; the token goes to **stdout
only**.

```bash
export SUPABASE_JWT_SECRET=<project jwt secret from the vault>   # never commit

FOUNDER_JWT="$(npm run --silent mint:jwt-offline -- --founder)"  # or: node scripts/mint-jwt-offline.mjs --founder
BOARD_JWT="$(npm run --silent mint:jwt-offline -- --board)"
FOUNDER_JWT="$FOUNDER_JWT" BOARD_JWT="$BOARD_JWT" scripts/live-check.sh   # asserts /me role mapping
```

`scripts/live-check.sh` also uses this path automatically: when no JWTs are passed
and the service-role admin path is unavailable, it mints founder/board tokens
offline from `SUPABASE_JWT_SECRET` and runs the role assertions — the tokens stay
in that process and are never printed or stored.

**b) Manual.** Send each user a magic link / OTP (Supabase dashboard **Send
magic link**, or `POST /auth/v1/otp`) and complete sign-in to receive an
`access_token`.

Then assert the role mapping directly:

```bash
FOUNDER_JWT=...   # obtained via (a) or (b); not stored in the repo
BOARD_JWT=...

curl -fsS -H "Authorization: Bearer $FOUNDER_JWT" \
  https://ig-board-production.up.railway.app/me
# -> {"id":"...","role":"admin","capabilities":["input_kpi_data","edit_kpi_data",...]}

curl -fsS -H "Authorization: Bearer $BOARD_JWT" \
  https://ig-board-production.up.railway.app/api/session
# -> {"id":"...","role":"board_member","capabilities":[]}
```

`/me` (or `/api/session`) returning `role: admin` with the full capability list
for the admin token and `role: board_member` with an empty capability list for
the board_member token is the proof that invite-only users, role claims, the
permissions map, and the API auth boundary are wired correctly end to end.

### One-time redacted `/me` role proof (live)

Captured against `https://ig-board-production.up.railway.app` using
ephemeral offline-minted JWTs (`scripts/mint-jwt-offline.mjs` + bound
`SUPABASE_JWT_SECRET`). **Tokens were never stored** — only status and `role`
are recorded here.

| Principal    | `Authorization`        | HTTP | Response (tokens/ids redacted) |
| ------------ | ---------------------- | ---- | ------------------------------ |
| Admin        | `Bearer <redacted>`    | 200  | `{"id":"<redacted>","role":"admin","capabilities":[...all four...]}` |
| Board member | `Bearer <redacted>`    | 200  | `{"id":"<redacted>","role":"board_member","capabilities":[]}` |

Unauthenticated regression (same host): no header → `401`
`{"error":"unauthorized",...}`; `Authorization: Bearer invalid.token.value` →
`401` `{"error":"unauthorized",...}` (never 500).

## Confirming the service-role path (server-only)

`apps/api/src/supabaseAdmin.js` reaches Supabase with the **service-role** key
from `process.env` only (`SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`); it fails
closed when either is unset. The **anon** key is never read there — it is for
client-side use only (see [`docs/env.md`](docs/env.md)). A quick reachability
smoke test (run by an operator, not at boot):

```bash
SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node -e \
  "import('./apps/api/src/supabaseAdmin.js').then(m => m.pingAdmin()).then(console.log)"
# -> { ok: true, status: 200 }
```

## Local unit / integration tests

```bash
npm test        # node --test in apps/api: auth boundary, /me, admin config, memos pipeline (no network)
```

## Founder memo upload pipeline

Founders upload meeting memos (`.docx` / `.pdf`); board is **read-only**. Files
live in a **private** storage path (never a public bucket). The only download
path is a **signed URL** minted by the API (1 hour / 3600s expiry). Text
extraction runs **server-side only** (`mammoth` for docx, PDF text extract for
pdf) — never in the browser.

Schema contract (`public.memos` + in-memory live realization when no Supabase
admin project is bound): `storage_path`, `meeting_date`, `status`
(`uploaded` → `analyzed`), `extracted_text`. Migration:
[`supabase/migrations/0004_memos_upload.sql`](supabase/migrations/0004_memos_upload.sql).

### Test accounts (non-secret)

Same invite-only users as `/me` above — no passwords in this repo:

| Role    | Email (default placeholder)  | Upload | Read memos |
| ------- | ---------------------------- | ------ | ---------- |
| Founder | `founder.e2e@boardroom.test` | yes    | yes        |
| Board   | `board.e2e@boardroom.test`   | **no** (403) | yes   |

Mint JWTs with `scripts/mint-jwt-offline.mjs` / `scripts/mint-test-jwt.mjs` as
documented above. **Never commit tokens.**

### Authenticated memo checks

```bash
export LIVE=https://ig-board-production.up.railway.app
# FOUNDER_JWT / BOARD_JWT obtained out of band (mint scripts) — never commit

# 3–5. Founder upload .docx / .pdf; poll until status=analyzed + extracted_text
curl -fsS -H "Authorization: Bearer $FOUNDER_JWT" -H 'Content-Type: application/json' \
  -d "{\"filename\":\"memo.docx\",\"meeting_date\":\"2026-07-15\",\"content_base64\":\"$(base64 -w0 sample.docx)\",\"content_type\":\"application/vnd.openxmlformats-officedocument.wordprocessingml.document\"}" \
  "$LIVE/api/memos"
# -> 201 { memo: { id, storage_path, meeting_date, status: uploaded|analyzed, extracted_text?, ... } }

curl -fsS -H "Authorization: Bearer $FOUNDER_JWT" -H 'Content-Type: application/json' \
  -d "{\"filename\":\"memo.pdf\",\"meeting_date\":\"2026-07-16\",\"content_base64\":\"$(base64 -w0 sample.pdf)\",\"content_type\":\"application/pdf\"}" \
  "$LIVE/api/memos"

# Poll (≤ ~60s) until both rows are analyzed with non-empty extracted_text:
curl -fsS -H "Authorization: Bearer $FOUNDER_JWT" "$LIVE/api/memos"

# 6–8. Signed URL (3600s) works; public URL and tampered token 4xx
SIGNED=$(curl -fsS -H "Authorization: Bearer $FOUNDER_JWT" \
  "$LIVE/api/memos/<id>/signed-url")
# body: { signedUrl, expiresIn: 3600, publicUrl, storage_path }
curl -s -o /dev/null -w '%{http_code}\n' "$(echo "$SIGNED" | jq -r .publicUrl)"   # -> 4xx
curl -s -o /dev/null -w '%{http_code}\n' "$(echo "$SIGNED" | jq -r .signedUrl)"   # -> 200
# Tamper the token query param → 4xx

# 9. Board read-only list
curl -fsS -H "Authorization: Bearer $BOARD_JWT" "$LIVE/api/memos"   # -> 200 { memos: [...] }

# 10. Board upload denied; no new row
curl -s -o /dev/null -w '%{http_code}\n' \
  -H "Authorization: Bearer $BOARD_JWT" -H 'Content-Type: application/json' \
  -d '{"filename":"x.pdf","meeting_date":"2026-07-01","content_base64":"YQ==","content_type":"application/pdf"}' \
  "$LIVE/api/memos"   # -> 403
```

Multipart is also accepted (`file` + `meeting_date` fields) when the client
sends `multipart/form-data`.

## Independent Analysis (AI-generated)

The analysis page (`/analysis`) shows the exact label **Independent Analysis
(AI-generated)** in light and dark themes. The browser calls **only** the
Fastify route `POST /api/independent-analysis` (same origin). There is **no**
Next.js `/api` route for analysis, and **no** Anthropic SDK, `sk-ant…` key, or
`api.anthropic.com` URL in any browser-served HTML/JS asset. The provider key
lives solely on Railway (`ANTHROPIC_API_KEY` from the vault).

### Inputs and output

Server-side the route assembles:

1. **KPI snapshot** from real `kpi_values` (committed seed + founder overlays,
   or the live Supabase table when admin is bound).
2. **Prior memos** with `extracted_text`, ordered by `meeting_date` (named-item
   slippage, nearly-complete watch, attribution, concentration).

When `ANTHROPIC_API_KEY` is bound, the model is **`claude-sonnet-4-6`** with the
`rigorous-independent-board-analyst` system prompt. When unbound, a deterministic
offline synthesizer still emits the five sections and cites at least one real
KPI name + value.

Markdown sections **in order**:

1. Summary  
2. Claims vs Scorecard (must cite ≥1 real KPI name + value)  
3. Slippage Watch  
4. Attribution Watch  
5. Questions the Board Should Ask  

### Documented failure-simulation trigger (test-only)

To exercise the UI **retry** path without a real Anthropic outage:

| Trigger | How |
| ------- | --- |
| Page URL | open `/analysis?simulate_anthropic_failure=1` (alias: `simulate_failure=1`) |
| API query | `POST /api/independent-analysis?simulate_anthropic_failure=1` |
| API header | `x-simulate-anthropic-failure: 1` |
| API body | `{ "simulateFailure": true }` |

The API responds `503` with `{ error: "anthropic_simulated_failure", retryable: true, simulate: true }`.
The page shows the retry state (`data-testid="analysis-retry-state"`) and a
**Retry analysis** control. Retry **disables** simulation (clears the query
flag) and re-requests; the second call succeeds with the five sections.

```bash
# Simulated failure (authenticated)
curl -s -o /dev/null -w '%{http_code}\n' \
  -H "Authorization: Bearer $BOARD_JWT" -H 'Content-Type: application/json' \
  -d '{}' \
  "$LIVE/api/independent-analysis?simulate_anthropic_failure=1"   # -> 503

# Success (offline or Anthropic)
curl -fsS -H "Authorization: Bearer $BOARD_JWT" -H 'Content-Type: application/json' \
  -d '{}' \
  "$LIVE/api/independent-analysis"
# -> 200 { ok: true, analysis: { markdown, model, source, sections, ... } }
```

### Phase 2 Playwright suite

```bash
npm run test:e2e:phase2:live   # against production Railway
# or: LIVE_URL=https://ig-board-production.up.railway.app npx playwright test e2e/phase2.spec.js
```

Covers label (light + dark), five headings in order, real KPI citation,
failure-simulation → retry success, Fastify network target, and no
`sk-ant` / `api.anthropic.com` in served assets.

## Board agenda generator (Phase 3)

The agenda page (`/agenda`) assembles a **time-blocked** board agenda from:

1. **Red / yellow KPIs** (latest value vs thresholds)
2. **Unresolved comments** (resolved comments are excluded on regenerate)
3. **Latest analysis** section **Questions the Board Should Ask**

Topics are ordered **bottom-up** through the pyramid: **Leadership Alignment
(layer 1) first → Enterprise Value (layer 5) last**. Layer 3 is **Revenue
Growth**. Within a layer: KPIs, then comments, then analysis questions.

`generated_content` and `edited_content` are stored **separately**. Founder
edits never clobber the generated original; regenerate/refetch refreshes only
`generated_content`.

| Method | Path | Who | Purpose |
| ------ | ---- | --- | ------- |
| `GET` | `/api/agenda` | founder + board | return current agenda (auto-generate if none) |
| `POST` | `/api/agenda/regenerate` | founder + board | rebuild generated topics; **keep** edits |
| `PATCH` | `/api/agenda` | founder only | save `edited_content` only |

```bash
# Authenticated agenda (time-blocked topics)
curl -fsS -H "Authorization: Bearer $FOUNDER_JWT" "$LIVE/api/agenda"
# -> 200 { agenda: { generated_content: { topics: [...] }, edited_content: null } }

# Save founder edit (generated original untouched)
curl -fsS -X PATCH -H "Authorization: Bearer $FOUNDER_JWT" \
  -H 'Content-Type: application/json' \
  -d '{"edited_content":"Board notes…"}' \
  "$LIVE/api/agenda"

# Regenerate (edits preserved)
curl -fsS -X POST -H "Authorization: Bearer $FOUNDER_JWT" \
  -H 'Content-Type: application/json' -d '{}' \
  "$LIVE/api/agenda/regenerate"
```

### Phase 3 Playwright suite

```bash
npm run test:e2e:phase3:live   # against production Railway
# or: LIVE_URL=https://ig-board-production.up.railway.app npx playwright test e2e/phase3.spec.js
```

Covers `/agenda` + home/analysis HTTP 200, multi-source time-blocked topics,
Leadership Alignment before Revenue Growth / Enterprise Value, edited vs
generated persistence, regenerate non-clobber, and unresolved/resolved comment
gating.
