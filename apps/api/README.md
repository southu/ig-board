# @ig-board/api

Fastify service for Boardroom. This mission exposes only public probes:

- `GET /health` → `200 { "status": "ok" }`
- `GET /version` → `200 { "sha", "version", "commit", "service" }` (deployed git SHA)

## Run

```bash
npm install                 # from repo root (workspaces)
PORT=8080 npm start         # node src/server.js
```

## Local verification

Both public probes are unauthenticated and return `200`. Verified locally
against `node apps/api/src/server.js`:

```bash
$ curl -s localhost:8080/health
{"status":"ok","uptime":2.0}

$ RAILWAY_GIT_COMMIT_SHA=$(git rev-parse HEAD) curl -s localhost:8080/version
{"sha":"<40-hex>","version":"<40-hex>","commit":"<40-hex>","service":"ig-board-api"}
```

The `/version` body carries the deployed `main` SHA (7+ hex), matching
`origin/main` HEAD on Railway where `RAILWAY_GIT_COMMIT_SHA` is injected.

## Version resolution

`src/version.js` resolves the SHA in order:

1. `RAILWAY_GIT_COMMIT_SHA` / `GIT_COMMIT_SHA` / `SOURCE_VERSION` / `GIT_SHA` (env)
2. `build-info.json` written at build time by `scripts/write-version.mjs`
3. `"unknown"` (endpoint still returns 200)

Deployed via `railway.json` at the repo root (Nixpacks, healthcheck `/health`).
