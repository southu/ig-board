# Boardroom (ig-board)

Private governance BI for **The Image Group** — a scorecard the board uses to run
the company from the top down.

This repository is a monorepo that future missions extend. This foundation
mission delivers the schema, seed, deny-by-default RLS, and a deployable API with
a `/version` endpoint. Full product UI is intentionally deferred.

## Layout

```
apps/
  api/        Fastify service (Railway) — public GET /health, GET /version; authed GET /me
  web/        Next.js 14 App Router app (static export) — invite-only login + boardroom theme, served by the API
supabase/
  migrations/ SQL migrations (schema + roles + deny-by-default RLS)
  seed.sql    single idempotent seed script (5 layers, 25 KPIs)
  seed.sh     wrapper: apply migrations then seed
scripts/
  write-version.mjs     build-time git SHA stamp for /version
  create-test-users.mjs admin/seed path for the invite-only founder + board users
  mint-test-jwt.mjs     server-side JWT mint (service-role) for the live /me check
  deploy-railway.sh      imperative Railway deploy (stamps the deployed SHA + vault vars)
  live-check.sh          non-secret live smoke check (health/version/auth-401/role)
docs/env.md    required env var NAMES (server vs client; no values)
DEPLOY.md      Railway service wiring + auth secrets (names only)
TESTING.md     live checks + the two invite-only test users (emails/roles only)
.env.example   local-dev template (no real secrets)
```

## API (apps/api)

A minimal Fastify service. The endpoints in this mission:

| Method | Path       | Auth       | Description                                              |
| ------ | ---------- | ---------- | ------------------------------------------------------- |
| GET    | `/health`  | none       | Liveness probe → `{ "status": "ok" }`                   |
| GET    | `/version` | none       | Deployed git SHA → `{ "sha", "version", ... }`          |
| GET    | `/ready`   | none       | Non-secret config readiness → `{ "ready", "checks" }` (booleans, no values) |
| GET    | `/me`      | Bearer JWT | Authenticated identity → `{ "id", "role" }` (`founder`\|`board`) |

`/health`, `/version`, and `/ready` are the public API probes. The same service
also serves the static **web app** (`/`, `/login`, `/_next/*`, …), which is
public — the client-side auth guard redirects unauthenticated visitors to
`/login`. Only the authenticated API surface — `/me` today, and any future
`/api/*` route — requires a valid Supabase JWT (`Authorization: Bearer <token>`)
or gets a `401`. The auth boundary (`apps/api/src/auth.js`) verifies HS256 tokens
against `SUPABASE_JWT_SECRET` — read from `process.env` only, never committed. See
[`DEPLOY.md`](DEPLOY.md) for the auth secrets and [`TESTING.md`](TESTING.md) for
the founder/board `/me` check.

`/version` resolves the SHA from `RAILWAY_GIT_COMMIT_SHA` (injected by Railway on
GitHub-connected services), falling back to a build-time stamp
(`apps/api/build-info.json`, written by `scripts/write-version.mjs`).

### Run locally

```bash
npm install
PORT=8080 npm start          # -> node apps/api/src/server.js
curl localhost:8080/health
curl localhost:8080/version
```

## Web (apps/web)

A Next.js 14 App Router app configured for static export (`output: 'export'`),
**served from the same Railway service as the API** so a single live URL covers
everything. The export ships as committed bytes in `apps/api/public` (the server
resolves it as a web root), so the deploy build never runs `next build` and thus
can never OOM the constrained Railway builder. The Fastify service serves that
export for all non-API routes; the API keeps `/health`, `/version`, `/ready`, `/me`.

- **Invite-only auth.** `/login` is the only public page — a magic-link email
  form (no password, no self-signup/register). Users are admin-created in
  Supabase. A client-side guard redirects unauthenticated visitors from every
  other route to `/login`.
- **Boardroom theme.** Light + dark navy/slate variants selected via
  `[data-theme]` on `<html>`. An inline pre-hydration head script sets the theme
  from `localStorage` (with a `prefers-color-scheme` fallback) before any bundle
  runs, so a hard reload never flashes the wrong theme. All colors flow through
  CSS variables defined once in `app/globals.css`; the toggle persists to
  `localStorage` (and, when signed in, the Supabase profile).

```bash
npm run build:web        # next build -> apps/web/out (+ hoist) + mirror -> apps/api/public
npm run build            # stamp the deployed SHA only (Railway buildCommand; serves committed export)
```

The web client reads `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY`
at build time (the anon key is public; RLS is the guard). When they are absent the
app still behaves correctly for verification — the guard treats the visitor as
signed-out and the login form confirms optimistically.

## Database (supabase/)

Postgres schema for Supabase with **deny-by-default Row Level Security** on every
table. See [`supabase/README.md`](supabase/README.md) for the full RLS matrix and
idempotency evidence.

Tables: `users`, `layers`, `kpis`, `kpi_values`, `memos`, `analyses`,
`comments` (threaded; exactly one of kpi/memo/analysis target), `agendas`,
`audit_log` (append-only / immutable).

### Apply migrations + seed

```bash
export DATABASE_URL=postgres://...      # a Supabase/Postgres connection string
./supabase/seed.sh                      # idempotent — safe to run repeatedly
```

## Deployment

The `apps/api` service is deployed on the Railway project **ig-board** and
redeploys on push to `main`. Railway config lives in `railway.json`
(Nixpacks builder, build `npm run build` — stamps the deployed SHA into
`apps/api/build-info.json`, start `node apps/api/src/server.js`, healthcheck
`/health`).

The live version endpoint serves the deployed `main` SHA:

```
GET https://ig-board-production.up.railway.app/version
```

Service wiring (project/service/domain) and the imperative deploy path
(`scripts/deploy-railway.sh`) are documented in [`DEPLOY.md`](DEPLOY.md).

## Configuration & secrets

No secrets live in this repo. Database URLs, service-role keys, and provider
tokens are provided at runtime via environment variables / the platform vault and
are never committed. Copy `.env.example` to `.env` for local values.

Required env var **names** (server vs client, which are secret) are documented in
[`docs/env.md`](docs/env.md): `SUPABASE_URL`, `SUPABASE_ANON_KEY` (client-only),
`SUPABASE_SERVICE_ROLE_KEY` (server-only), `SUPABASE_JWT_SECRET`, and
`ANTHROPIC_API_KEY` (server-only independent analysis). The API reaches Supabase
with the service-role key server-side only (`apps/api/src/supabaseAdmin.js`,
env-only, fail-closed). Analysis runs only on Fastify
(`POST /api/independent-analysis`); the browser never holds Anthropic keys or
calls `api.anthropic.com`.

## Testing

[`TESTING.md`](TESTING.md) covers the live health/version/auth checks and the
documented admin path for the two invite-only test users (one founder, one
board) used by the authenticated `/me` check — emails and role mapping only, no
passwords or tokens.
