# Environment variables

Runtime configuration for Boardroom (`ig-board`). This document lists the
**names** of every environment variable the services read. **No values live in
this repo.** Secrets are provided at runtime from the platform vault / Railway
service variables and are never committed, logged, or returned in a response.

Copy [`.env.example`](../.env.example) to `.env` for local development and fill
in your own values there (`.env` is git-ignored).

## Server (apps/api) — never sent to a browser

These are set as Railway service variables on the `api` service of the
`ig-board` project, sourced from the vault. The API reads them from
`process.env` only.

| Name                        | Secret? | Purpose                                                                                  |
| --------------------------- | ------- | ---------------------------------------------------------------------------------------- |
| `SUPABASE_URL`              | no      | Base URL of the Supabase project (e.g. `https://<ref>.supabase.co`). Used for admin ops. |
| `SUPABASE_SERVICE_ROLE_KEY` | **yes** | Service-role key. **Bypasses RLS** — server-only privileged access for admin operations. |
| `SUPABASE_JWT_SECRET`       | **yes** | HMAC secret used to verify Supabase HS256 JWTs at the auth boundary (`apps/api/src/auth.js`). |
| `ANTHROPIC_API_KEY`         | **yes** | Provider key for the analyst/agent features (added in a later mission). Server-only. Surfaced as the informational `anthropic` boolean on `/ready` (never gates readiness). |
| `DATABASE_URL`              | **yes** | Postgres connection string for migrations + seed (`supabase/seed.sh`).                   |
| `RESEND_API_KEY`            | **yes** | Optional. Lights up **magic-link email delivery** for the self-hosted auth backend via the Resend HTTPS API (`apps/api/src/mailer.js`). When neither this nor `MAIL_WEBHOOK_URL` is set — and no external Supabase project is bound — `POST /auth/v1/otp` fails closed with `503 email_delivery_unconfigured` and the login page shows an honest "temporarily unavailable" instead of a false "check your email". Server-only. |
| `MAIL_WEBHOOK_URL`          | no      | Optional alternative to `RESEND_API_KEY`: a relay endpoint the mailer POSTs `{ to, from, subject, html, text }` to (SES/Mailgun/Postmark shim, etc.). Enables magic-link delivery the same way. |
| `AUTH_EMAIL_FROM`           | no      | Optional verified sender for magic-link emails (defaults to `Boardroom <login@theimagegroup.com>`). |
| `PORT`                      | no      | Port the API binds (Railway injects; defaults to `8080`).                                |
| `HOST`                      | no      | Bind address (defaults to `0.0.0.0`).                                                     |
| `WEB_ROOT`                  | no      | Optional override for the static web export dir the API serves. Auto-detected when unset; the server logs the resolved root at boot (`apps/api/src/server.js`). |

> `SUPABASE_SERVICE_ROLE_KEY` and `ANTHROPIC_API_KEY` grant privileged / billable
> access. They must **never** appear in client code, commits, logs, or mission
> text — only in the vault and the runtime environment.

## Client (apps/web) — safe to expose to the browser

The web app talks to Supabase with the **anon** key only. RLS (deny-by-default)
is what protects the data; the anon key is a public identifier, not a secret.

Because the web app ships as a **committed static export** (Railway never runs
`next build` — see [`DEPLOY.md`](../DEPLOY.md)), `NEXT_PUBLIC_*` env can't be
inlined into the live bundle. Instead the client fetches its browser-safe config
at runtime from the public `GET /config` endpoint, which the API assembles from
its own server env:

| Name                  | Secret? | Purpose                                                       |
| --------------------- | ------- | ------------------------------------------------------------- |
| `SUPABASE_URL`        | no      | Project URL, served to the client via `GET /config`.          |
| `SUPABASE_ANON_KEY`   | no      | Supabase anon (public) key. **Optional** — when unset the API mints a valid `role:"anon"` key from `SUPABASE_JWT_SECRET` (`apps/api/src/publicConfig.js`) so no separate anon key has to be provisioned. **Client-side only.** Never grants more than RLS allows. |

> The **anon** key path is used only client-side (served via `GET /config`, which
> exposes only the URL + anon key — never the service-role key or JWT secret). The
> **service-role** key is used only server-side (`apps/api`). Never swap them:
> shipping the service-role key to a browser would bypass RLS for every visitor.

## Provisioning on Railway

Service variables for the `ig-board` project are provisioned from the vault, not
from this repo. The non-secret provision summary (project/service/domain,
variable **names**) is what gets referenced here; the values stay in the vault.
See [`DEPLOY.md`](../DEPLOY.md) for how the `api` service is wired and deployed,
and [`TESTING.md`](../TESTING.md) for how the live test users are created with
the service-role key.
