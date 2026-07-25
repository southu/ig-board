# Admin / Role Status Audit — jason@jasonharper.com

**Type:** read-only investigation (no application behavior changed)
**Date:** 2026-07-25
**Scope:** ig-board user/auth store, user model role field, logout/session-invalidation function

---

## 1. Email queried

    jason@jasonharper.com

## 2. Current admin / role value found for that account

**admin=false** — no account with the email `jason@jasonharper.com` exists in the
ig-board user/auth store, so no admin flag and no role value is stored for it
(role=none / account not found).

Evidence:

- A full-repository search for `jasonharper` returns zero matches in seed data,
  migrations, or application code. No user row, invite entry, or role assignment
  references `jason@jasonharper.com`.
- The store's seeded principals (`apps/api/src/usersStore.js`) contain no
  `jasonharper.com` address. The only "jason" principal in the system is
  `jason@readysignal.com` — the **Operator Admin** (`role=admin`), seeded at
  `apps/api/src/usersStore.js:90` and forced to admin at
  `apps/api/src/usersStore.js:159`.
- The live deployment's public governance status
  (`GET /api/governance/status`) reports
  `"operator_admin_email":"jason@readysignal.com"` — again, not
  `jason@jasonharper.com`.

Conclusion for the queried email: **admin=false, role=none (account does not
exist as stored today).** The distinct, existing account `jason@readysignal.com`
is `role=admin`, but that is a different email and was neither queried nor
modified.

## 3. Existing role / is_admin field definition on the user/account model

The user/account model has no boolean `is_admin`/`admin` column — admin status is
expressed through a single `role` text field. Its definition lives in the schema
migrations (authoritative) and is mirrored on the application-layer model.

- **Original field definition (schema / migration):**
  `supabase/migrations/0001_schema.sql:15`
  ```sql
  role       text not null check (role in ('founder', 'board')),
  ```
- **Current governance definition of the same field** (default + five-value
  check constraint):
  `supabase/migrations/0008_governance.sql:79` (`alter column role set default 'employee'`)
  and `supabase/migrations/0008_governance.sql:114` (re-applies
  `check (role in ('admin', 'executive', 'board_member', 'employee', 'consultant'))`).
- **Application-layer model (in-memory + ORM row shape):** the `role` field on
  the user row in `apps/api/src/usersStore.js:50` (`role: row.role` in
  `publicUser`); an account is an admin when this field equals the string
  `admin`.

## 4. Existing logout / session-invalidation function or endpoint

There is **no server-side logout endpoint**; sessions are stateless Supabase-style
JWTs and are invalidated client-side by discarding the stored session.

- **Session-invalidation function:** `apps/web/lib/auth.js:99`
  — `export function clearSession()` (lines 99–107). It removes the persisted
  session from `localStorage` and clears the session cookie.
- **Where it is invoked (logout control):** `apps/web/components/SignOut.js:18`
  — the `onSignOut()` handler (lines 18–21) calls `clearSession()` and redirects
  to `/login`.

---

## 5. Confirmation of no behavior change

This run added only:

1. this report file (`docs/reports/jason-harper-admin-audit.md`), and
2. a read-only route that serves this report's raw contents at
   `GET /reports/jason-harper-admin-audit`.

No user row, no `role` field value (including `jason@readysignal.com`'s
`role=admin`), no field definition, and no logout/session-invalidation code was
modified. The queried account `jason@jasonharper.com` did not exist before this
run and still does not exist after it.
