# Boardroom (ig-board)

Private governance BI for **The Image Group** — a scorecard the board uses to run
the company from the top down.

This repository is a monorepo that future missions extend. This foundation
mission delivers the schema, seed, deny-by-default RLS, and a deployable API with
a `/version` endpoint. Full product UI is intentionally deferred.

## Layout

```
apps/
  api/        Fastify service (Railway) — public GET /health and GET /version
  web/        Next.js 14 App Router stub (static-export capable)
supabase/
  migrations/ SQL migrations (schema + roles + deny-by-default RLS)
  seed.sql    single idempotent seed script (5 layers, 25 KPIs)
  seed.sh     wrapper: apply migrations then seed
scripts/
  write-version.mjs   build-time git SHA stamp for /version
```

## API (apps/api)

A minimal Fastify service. The only endpoints in this mission:

| Method | Path       | Auth | Description                                    |
| ------ | ---------- | ---- | ---------------------------------------------- |
| GET    | `/health`  | none | Liveness probe → `{ "status": "ok" }`          |
| GET    | `/version` | none | Deployed git SHA → `{ "sha", "version", ... }` |

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

A Next.js 14 App Router stub configured for static export (`output: 'export'`).
It is a placeholder for the board scorecard UI in later missions.

```bash
npm install
npm run build --workspace apps/web   # emits static site to apps/web/out
```

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

## Secrets

No secrets live in this repo. Database URLs, service-role keys, and provider
tokens are provided at runtime via environment variables / the platform vault and
are never committed. Copy `.env.example` to `.env` for local values.
