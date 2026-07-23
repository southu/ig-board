# Testing Boardroom live

How the live deployment (<https://ig-board-production.up.railway.app>) is
verified, and how the two invite-only Supabase test users are created.

**No passwords, magic-link URLs, JWTs, or service-role keys appear in this repo.**
Secrets are supplied at runtime from the vault — see [`docs/env.md`](docs/env.md).

## Public endpoints (no auth)

```bash
curl -fsS https://ig-board-production.up.railway.app/health    # -> 200 {"status":"ok",...}
curl -fsS https://ig-board-production.up.railway.app/version   # -> 200 {"sha": "<origin/main HEAD>", ...}
curl -fsS https://ig-board-production.up.railway.app/ready     # -> 200 {"ready":true,"checks":{"authSecret":true,"supabaseAdmin":true,"anthropic":false}}
```

`/ready` reports **booleans only** (never any value): `authSecret` confirms
`SUPABASE_JWT_SECRET` is bound (so `/me` can authenticate) and `supabaseAdmin`
confirms `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` are bound (server-side admin
ops). `anthropic` confirms `ANTHROPIC_API_KEY` is bound — **informational only**
(the analyst features land in a later mission), so it never gates `ready`. It is
the non-secret way to confirm the vault-provisioned env reached the Railway `api`
service before running the authenticated checks below.

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

Two invite-only Supabase users back the authenticated (`/me`) checks. Emails are
**non-secret placeholders** — override them (see below) to point at real
invite-capable inboxes you control.

| Role      | Email (default placeholder) | `app_metadata.role` | `/me` returns   |
| --------- | --------------------------- | ------------------- | --------------- |
| Founder   | `founder.e2e@boardroom.test`| `founder`           | `role: founder` |
| Board     | `board.e2e@boardroom.test`  | `board`             | `role: board`   |

The API reads the role from the JWT's `app_metadata.role`
(`apps/api/src/auth.js` → `extractRole`), and RLS resolves it from
`public.users.role` (`supabase/migrations/0002_roles.sql`). The seed path below
sets **both** so the two stay consistent.

### How operators create them (documented admin/seed path)

Run the idempotent admin script with the service-role key from the vault. The
key is read from the environment only and is never printed or stored:

```bash
export SUPABASE_URL=https://<ref>.supabase.co
export SUPABASE_SERVICE_ROLE_KEY=<service-role-key-from-vault>   # never commit this
# Optional: use real inboxes instead of the placeholders.
# export FOUNDER_TEST_EMAIL=founder+e2e@yourdomain.com
# export BOARD_TEST_EMAIL=board+e2e@yourdomain.com

npm run seed:test-users        # alias for: node scripts/create-test-users.mjs
```

The script (`scripts/create-test-users.mjs`) for each user:

1. Creates the Supabase **auth** user **without a password** (invite-only — they
   sign in later with a magic link / OTP), with `email_confirm: true`.
2. Sets `app_metadata.role` to `founder` / `board` so the issued JWT carries the
   app role the API reads.
3. Upserts the matching `public.users` row (`id` = auth user id) so RLS resolves
   the role. Idempotent — safe to re-run.

Equivalent manual path (Supabase dashboard): **Authentication → Users → Add
user** for each email, then edit the user's **App Metadata** to `{"role":
"founder"}` / `{"role": "board"}`, and insert the matching `public.users` row
with the same `id`, `email`, and `role`.

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
the API verifies against (`/ready` reports it as `authSecret: true`). It needs no
reachable Supabase project or service-role key and no `npm install` (Node
built-in `crypto` only), so the live `/me` role check works as soon as the JWT
secret is provisioned, even before the admin path (`supabaseAdmin`) is. The token
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
  https://ig-board-production.up.railway.app/me    # -> {"id":"...","role":"founder"}

curl -fsS -H "Authorization: Bearer $BOARD_JWT" \
  https://ig-board-production.up.railway.app/me     # -> {"id":"...","role":"board"}
```

`/me` returning `role: founder` for the founder token and `role: board` for the
board token is the proof that the invite-only users, their role claims, and the
API auth boundary are all wired correctly end to end.

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
npm test        # node --test in apps/api: auth boundary, /me, admin config (no network)
```
