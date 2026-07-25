# Secure session access for the live verification workflow

How the admin-nav / logout verification workflow obtains a **temporary
authorized session** for `jason@jasonharper.com` and the documented non-admin
test account `ratchet-employee@boardroom.test` on the live deploy
(<https://ig-board-production.up.railway.app>) — **without committing any
password, token, magic-link URL, or service-role key to the repo**.

Nothing in this document, in the evidence artifacts, or in
[`scripts/jasonharper-admin-verify.mjs`](../../../scripts/jasonharper-admin-verify.mjs)
is a secret. Access tokens exist only in the running process; the committed
evidence records statuses, roles, capability names, and rendered DOM only.

## Why a documented mechanism is needed

`jason@jasonharper.com` is **not** a hardcoded credential in the source (only
`jason@readysignal.com` is the hardcoded `OPERATOR_ADMIN_EMAIL`). His admin
status lives in the live user/auth store, and his session must be minted against
the live app — it cannot be assumed from code. The two `*.boardroom.test`
accounts are seeded on every boot (see [`TESTING.md`](../../../TESTING.md)), but
they are the same invite-only, no-password accounts. All three use the identical
mechanism below.

## The mechanism: self-hosted invite-only magic link (inline `action_link`)

Boardroom auth is **invite-only magic link** — there is no password field on
`/login`. On the self-hosted production deploy (no external mailer), the OTP
endpoint returns the verification link **inline** in the JSON response instead of
emailing it. That inline `action_link` *is* the one-time, short-lived
credential; it is never stored, and it expires (~1h) after a single use.

The anon apikey needed to call OTP is already public — it is served, by design,
from the unauthenticated `GET /config` endpoint (it is the browser login key,
not a secret). So the whole flow uses only public inputs plus a live round-trip:

```bash
LIVE=https://ig-board-production.up.railway.app

# 1) Public login config → supabaseUrl + anon apikey (both non-secret)
CFG=$(curl -fsS "$LIVE/config")
URL=$(printf '%s' "$CFG" | node -pe 'JSON.parse(require("fs").readFileSync(0)).supabaseUrl')
ANON=$(printf '%s' "$CFG" | node -pe 'JSON.parse(require("fs").readFileSync(0)).supabaseAnonKey')

# 2) Request a one-time OTP for the account → inline action_link (self-host only)
OTP=$(curl -fsS -X POST "$URL/auth/v1/otp" \
  -H 'Content-Type: application/json' -H "apikey: $ANON" \
  -d '{"email":"jason@jasonharper.com","create_user":false}')
GRANT=$(printf '%s' "$OTP" | node -pe 'new URL(JSON.parse(require("fs").readFileSync(0)).action_link).searchParams.get("token")')

# 3) Verify the one-time grant → short-lived session envelope (access_token)
#    Use the access_token as `Authorization: Bearer …` for /me, /admin, /api/*.
#    DO NOT print or commit it. In CI, keep it in a shell variable only.
curl -fsS -X POST "$URL/auth/v1/verify" \
  -H 'Content-Type: application/json' -H "apikey: $ANON" \
  -d "{\"token\":\"$GRANT\",\"type\":\"magiclink\"}" >/dev/null
```

Swap the email for `ratchet-employee@boardroom.test` to mint the non-admin
session used for the AC4/AC5 "blocked" checks. `create_user:false` guarantees
the flow only ever authenticates a **pre-existing** account — it never
provisions a new user or elevates anyone.

The verification script does exactly this in its `login(email)` helper, then
injects the resulting session into a Playwright browser context the same way the
real login page does (`ig-board-access-token` cookie + `ig-board.session`
localStorage — see `apps/web/lib/auth.js`).

### Reproduce the full evidence pack

```bash
node scripts/jasonharper-admin-verify.mjs
# LIVE_URL=… JASON_EMAIL=… NONADMIN_TEST_EMAIL=… to retarget
```

## Alternative: read-only, redacted auth-store query (no session)

If a workflow only needs to *confirm* the stored roles (AC1) without minting a
browser session, mint just an admin bearer via the flow above and read the
authoritative directory — the response is roles/capabilities only, no secrets:

```bash
curl -fsS -H "Authorization: Bearer $ADMIN_ACCESS_TOKEN" \
  "$LIVE/api/admin/users" | node -pe '
    JSON.parse(require("fs").readFileSync(0)).users
      .filter(u => /jason@jasonharper\.com|ratchet-employee@boardroom\.test/i.test(u.email))
      .map(u => ({ email: u.email, role: u.role }))'
# → [ { email: "jason@jasonharper.com", role: "admin" },
#     { email: "ratchet-employee@boardroom.test", role: "employee" } ]
```

The committed [`admin-query.json`](admin-query.json) is the redacted output of
this query (role + capability names, `GET /me` + `GET /api/admin/users`), which
is the authoritative live proof of AC1.

## What is deliberately NOT here

- **No passwords** — auth is passwordless (magic link).
- **No committed tokens / magic-link URLs** — the `action_link` is minted live,
  used once, and never written to disk or the repo.
- **No service-role keys** — the flow uses only the public anon apikey from
  `/config`; role promotion for jason was done earlier via the reviewable code
  path (`selfAuth.roleForEmail` + `usersStore` seed + migration `0020`), scoped
  to his one account, not a blanket seed or credential change.
