# Testing Boardroom live

How the live deployment (<https://ig-board-production.up.railway.app>) is
verified, and how the two invite-only Supabase test users are created.

**No passwords, magic-link URLs, JWTs, or service-role keys appear in this repo.**
Secrets are supplied at runtime from the vault — see [`docs/env.md`](docs/env.md).

## Public endpoints (no auth)

```bash
curl -fsS https://ig-board-production.up.railway.app/health    # -> 200 {"status":"ok",...}
curl -fsS https://ig-board-production.up.railway.app/version   # -> 200 {"sha": "<origin/main HEAD>", ...}
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

node scripts/create-test-users.mjs
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

Send each user a magic link / OTP (Supabase dashboard **Send magic link**, or
`POST /auth/v1/otp`) and complete sign-in to receive an `access_token`. That
token is a short-lived secret: **use it only in the shell for the check below;
never commit or log it.**

```bash
FOUNDER_JWT=...   # obtained out-of-band; not stored in the repo
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
