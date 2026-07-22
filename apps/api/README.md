# @ig-board/api

Fastify service for Boardroom.

## Endpoints

Public (no auth):

- `GET /health` → `200 { "status": "ok" }`
- `GET /version` → `200 { "sha", "version", "commit", "service" }` (deployed git SHA)

Authenticated — require `Authorization: Bearer <supabase-jwt>`; missing/invalid → `401`:

- `GET /me` → `200 { "id", "role" }` where `role` is `founder` or `board`
- every other route

## Auth boundary

`src/auth.js` registers a global `onRequest` hook. Only `GET /health` and
`GET /version` bypass it; everything else demands a valid Supabase JWT.

- Tokens are verified **HS256** against `process.env.SUPABASE_JWT_SECRET` (the
  project's JWT secret) using Node's built-in `crypto` — no external deps.
  Bad signature, expired/`nbf`, `alg:none`/non-HS256, or a missing secret all
  fail closed with `401`. The secret is read from env only and never logged or
  returned in a body.
- `role` is extracted from the JWT claims (`app_metadata.role` /
  `user_metadata.role` / `roles[]` / top-level custom claims), restricted to
  `founder` | `board`.

Set `SUPABASE_JWT_SECRET` (and any server-only `SUPABASE_SERVICE_ROLE_KEY`) as a
Railway service variable from the vault — see `../../DEPLOY.md`.

## Run

```bash
npm install                 # from repo root (workspaces)
PORT=8080 npm start         # node src/server.js
```

## Local verification

```bash
$ curl -s localhost:8080/health
{"status":"ok","uptime":2.0}

$ RAILWAY_GIT_COMMIT_SHA=$(git rev-parse HEAD) curl -s localhost:8080/version
{"sha":"<40-hex>","version":"<40-hex>","commit":"<40-hex>","service":"ig-board-api"}

$ curl -s -o /dev/null -w '%{http_code}\n' localhost:8080/me            # 401 (no token)
$ curl -s -H "Authorization: Bearer <valid-jwt>" localhost:8080/me      # 200 { "id", "role" }
```

The `/version` body carries the deployed `main` SHA (7+ hex), matching
`origin/main` HEAD on Railway where `RAILWAY_GIT_COMMIT_SHA` is injected.

## Version resolution

`src/version.js` resolves the SHA in order:

1. `RAILWAY_GIT_COMMIT_SHA` / `GIT_COMMIT_SHA` / `SOURCE_VERSION` / `GIT_SHA` (env)
2. `build-info.json` written at build time by `scripts/write-version.mjs`
3. `"unknown"` (endpoint still returns 200)

Deployed via `railway.json` at the repo root (Nixpacks, healthcheck `/health`).
