# Deploying the Boardroom API to Railway

The `apps/api` Fastify service runs as the **`api`** service inside the
provisioned **`ig-board`** Railway project (`production` environment). Two
endpoints are public, everything else requires a valid Supabase JWT
(`Authorization: Bearer <token>`); missing/invalid tokens get a `401`.

- `GET /health`  → `200 {"status":"ok",...}` — public.
- `GET /version` → `200 {"sha":"<git sha>", ...}` — public; the deployed `main` HEAD.
- `GET /me`      → `200 {"id","role"}` — authenticated; `role` is `founder` or `board`.

## Auth secrets (server-only, from the vault)

JWT verification needs the project's **JWT secret** as a Railway service variable
(sourced from the vault — never committed):

| Variable                    | Purpose                                            |
| --------------------------- | -------------------------------------------------- |
| `SUPABASE_URL`              | Supabase project URL for server-side admin ops.    |
| `SUPABASE_JWT_SECRET`       | HMAC key used to verify Supabase HS256 JWTs.       |
| `SUPABASE_SERVICE_ROLE_KEY` | Server-only privileged key; never sent to clients. |

These are set as `api`-service variables on the `ig-board` project, provisioned
from the vault (only the non-secret provision summary — names, project/service —
is referenced in-repo; values never are). The full name reference, including the
client-side `SUPABASE_ANON_KEY` and the later `ANTHROPIC_API_KEY`, lives in
[`docs/env.md`](docs/env.md).

Without `SUPABASE_JWT_SECRET` the auth boundary fails closed: `/health` and
`/version` still serve, but every authenticated route (e.g. `/me`) returns `401`.
`apps/api/src/auth.js` reads these from `process.env` only; no value is ever
hardcoded, logged, or returned in a response body.

Live URL: <https://ig-board-production.up.railway.app>

## How the service is wired

| Concern        | Value                                                             |
| -------------- | ---------------------------------------------------------------- |
| Project        | `ig-board` (`production` env)                                     |
| Service        | `api`                                                             |
| Public domain  | `ig-board-production.up.railway.app` → container port **8080**    |
| Build          | `railway.json` → NIXPACKS, `buildCommand: npm run build`          |
| Start          | `node apps/api/src/server.js` (binds `process.env.PORT`)          |
| Healthcheck    | `/health` (see `railway.json`)                                    |
| Version source | `RAILWAY_GIT_COMMIT_SHA` (GitHub deploys) or `GIT_COMMIT_SHA` var |

`apps/api/src/version.js` resolves the SHA from the first non-empty of
`RAILWAY_GIT_COMMIT_SHA`, `GIT_COMMIT_SHA`, `SOURCE_VERSION`, `GIT_SHA`, then the
build-time `apps/api/build-info.json`, then `"unknown"`. When the service is
GitHub-connected, Railway injects `RAILWAY_GIT_COMMIT_SHA` automatically and no
manual step is needed. For an imperative `railway up` deploy (no Git metadata),
set `GIT_COMMIT_SHA` to the deployed commit so `/version` stays accurate.

## Deploy (imperative, from a clean checkout of `main`)

Requires the Railway CLI authenticated via `RAILWAY_API_TOKEN` (never commit it).

```bash
# From the repo root, on the commit you want live (working tree clean):
scripts/deploy-railway.sh
```

The script links the `ig-board` project's `api` service, stamps the current
`HEAD` SHA into the `GIT_COMMIT_SHA` service variable, and runs `railway up`.
Railway builds with NIXPACKS, runs the `/health` healthcheck, and routes the
`ig-board-production` domain to port 8080.

No tokens, service-role keys, or Anthropic keys are stored in this repo or in
any deploy artifact — only public URLs and non-secret identifiers.
