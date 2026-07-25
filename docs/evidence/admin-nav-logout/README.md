# Admin nav / logout — live verification evidence

Verification of the admin-nav / admin-panel / logout feature on the live
Boardroom deploy (<https://ig-board-production.up.railway.app>), captured for
operator **jason@jasonharper.com** and the documented non-admin test account
**ratchet-employee@boardroom.test**.

- **Captured against deployed SHA:** `a226d4652892e10f02e33ed3fc6c8fed16356517`
- **Reproduce:** `node scripts/jasonharper-admin-verify.mjs`
  (`LIVE_URL=…` to target another host). No secrets are printed or stored —
  access tokens live only in the process; the evidence records statuses, roles,
  capability names, and rendered DOM only.
- **How the workflow gets an authorized session (secret-free):**
  [`session-access.md`](session-access.md) documents the self-hosted invite-only
  magic-link (inline `action_link`) flow used to mint temporary sessions for
  `jason@jasonharper.com` and `ratchet-employee@boardroom.test`, plus the
  read-only redacted auth-store query — no passwords, tokens, or service-role
  keys committed.
- **Result:** 14/14 checks green (see [`summary.json`](summary.json)).

## The four evidence artifacts

| # | Acceptance criterion | Artifact |
| - | -------------------- | -------- |
| 1 | AC1 — live user/auth store shows `jason@jasonharper.com` `role=admin` / `access_admin_area=true` | [`admin-query.json`](admin-query.json) |
| 2 | AC2 + AC3 — as jason: Admin nav link (`data-testid=admin-nav`) visible; `/admin` returns 200 and renders the admin user list | [`screenshots/01-admin-nav-and-panel.png`](screenshots/01-admin-nav-and-panel.png) |
| 3 | AC4 + AC5 — as the non-admin: Admin nav link absent; `GET /admin` and `GET /api/admin/users` return **403** (never 200 with admin content) | [`screenshots/02-nonadmin-no-admin-nav.png`](screenshots/02-nonadmin-no-admin-nav.png) + [`nonadmin-blocked.json`](nonadmin-blocked.json) |
| 4 | AC6 — clicking Sign out terminates the session: replaying the same token to `/me`, `/admin`, `/admin.txt` is refused, and a same-session browser navigation to `/admin` lands on `/login` | [`screenshots/03-logout-session-terminated.png`](screenshots/03-logout-session-terminated.png) + [`logout-proof.json`](logout-proof.json) |

## 1 — jason@jasonharper.com is admin (AC1)

`jason@jasonharper.com` is promoted to admin via the **reviewable code path**
(`selfAuth.roleForEmail` + `usersStore` seed + migration `0020`), not a blanket
seed change and with no hardcoded credentials. He is distinct from
`jason@readysignal.com` (the other hardcoded operator admin). The authoritative
live query proves the resulting state:

- `GET /me` (per-request role resolved from the users store) →
  `role: "admin"`, `capabilities` include `access_admin_area`.
- `GET /api/admin/users` (admin directory) → his row is `role: "admin"`.

Note: `full_name` on his row reads "Board Member Test" because a production env
var (`BOARD_MEMBER_TEST_EMAIL`) is bound to his address; the `RESERVED_ROLE_EMAILS`
guard in `usersStore.js` keeps his **role** at `admin` regardless — an env-derived
board seed can no longer silently re-demote a reserved admin.

## 2 — admin nav link + admin panel (AC2/AC3)

Signed in as jason, the header renders the **Admin** link (`data-testid=admin-nav`,
`href=/admin`); following it loads the admin panel (`/admin` → 200) with the
populated user list (`admin-users-table`, 64 rows).

## 3 — non-admin blocked (AC4/AC5)

Signed in as `ratchet-employee@boardroom.test` (employee, `input_kpi_data` only):
the header shows the standard nav (Memos / Analysis / Comments / Agenda / What's
new / Update KPIs / Log out) with **no Admin link**. Direct requests to
`GET /admin` and `GET /api/admin/users` both return **403** — never 200 with
admin content.

## 4 — logout terminates the session (AC6)

Clicking **Sign out** (`data-testid=sign-out`) revokes the session server-side.
After logout, replaying the same access token is refused everywhere:

| Request (same token, after logout) | Status |
| ---------------------------------- | ------ |
| `GET /me`                          | 401 |
| `GET /admin` (page)                | 302 → `/login` |
| `GET /admin.txt` (RSC payload)     | 302 → `/login` |
| `GET /api/admin/users`             | 401 |

The browser proof shows a same-session navigation to `/admin` landing on the
`/login` sign-in form.

### Bug fixed this iteration

The `/me` + `/api/*` boundary already refused revoked tokens, but the admin
**page** gate (`authorizeAdminPage`) verified only the JWT signature + role and
never consulted the revocation store — so a logged-out admin token still returned
**200** for `GET /admin` and `GET /admin.txt`. Fixed in
`apps/api/src/server.js` by checking `isSessionTokenRevoked` in
`authorizeAdminPage` (treating a revoked token like no session → redirect to
`/login`), with regression coverage in
`apps/api/test/admin-page-guard.test.js`. Now Sign out terminates access to the
admin page and its prefetched RSC payload too, not only the data APIs.

## Re-run live (no secrets)

```bash
./scripts/verify-admin-nav-live.sh
# or:
LIVE_URL=https://ig-board-production.up.railway.app ./scripts/verify-admin-nav-live.sh
```

Uses invite-only magic-link OTP (`POST /auth/v1/otp` → inline `action_link`) documented in `TESTING.md`.
Accounts: `jason@jasonharper.com` (admin), `ratchet-employee@boardroom.test` (non-admin).
