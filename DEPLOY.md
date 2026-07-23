# Deploying the Boardroom API to Railway

## How deploys are triggered

**Primary path: GitHub auto-deploy on push to `main`.** The Railway `api`
service is connected to this GitHub repository. Every push to `main` triggers a
new Railway build/deploy automatically — no manual step or script is required
for a normal ship. After deploy, `GET /version` on the live domain reports the
commit Railway just built (`RAILWAY_GIT_COMMIT_SHA`).

**Fallback / imperative path:** `scripts/deploy-railway.sh` (Railway CLI +
`railway up`) when you need to redeploy without a git push, rebind vault env
vars, or recover from a stuck auto-deploy. See [Deploy (imperative)](#deploy-imperative-from-a-clean-checkout-of-main) below.

## Authoritative service and domain

| Concern       | Value |
| ------------- | ----- |
| Project       | `ig-board` (`production` environment) |
| Service       | `api` |
| Public domain | **https://ig-board-production.up.railway.app** |

That domain is the single authoritative live URL for health/version probes and
the static web app. There is no separate web service.

---

The `apps/api` Fastify service runs as the **`api`** service inside the
provisioned **`ig-board`** Railway project (`production` environment). It serves
both the public API probes and the static **web app** (`apps/web/out`: `/`,
`/login`, `/_next/*`, …), so a single live URL satisfies every check. Only the
authenticated API surface — `/me` and any future `/api/*` — requires a valid
Supabase JWT (`Authorization: Bearer <token>`); missing/invalid tokens get a
`401`. The web app is public and its client-side guard redirects unauthenticated
visitors to `/login`.

- `GET /health`  → `200 {"status":"ok",...}` — public.
- `GET /version` → `200 {"sha":"<git sha>", ...}` — public; the deployed `main` HEAD.
- `GET /ready`   → `200 {"ready":<bool>,"checks":{"authSecret","supabaseAdmin","loginConfig","mailer","anthropic"}}` — public; non-secret booleans confirming the vault-provisioned server env is bound (no values). `mailer` confirms a magic-link email backend (`RESEND_API_KEY` / `MAIL_WEBHOOK_URL` / `SMTP_*`) is bound so `POST /auth/v1/otp` can actually send; `loginConfig`, `mailer`, and `anthropic` are informational and never gate `ready`.
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
| Build          | `railway.json` → NIXPACKS, `buildCommand: npm run build` → `scripts/build.mjs` (stamps the deployed SHA only; `next build` is deliberately NOT run on deploy — the web app ships as the committed `apps/api/public` export, so the constrained builder can never OOM and freeze the deploy) |
| Start          | `node apps/api/src/server.js` (binds `process.env.PORT`)          |
| Healthcheck    | `/health` (see `railway.json`)                                    |
| Version source | `RAILWAY_GIT_COMMIT_SHA` (GitHub deploys) or `GIT_COMMIT_SHA` var |

`apps/api/src/version.js` resolves the SHA from the first non-empty of
`RAILWAY_GIT_COMMIT_SHA`, `GIT_COMMIT_SHA`, `SOURCE_VERSION`, `GIT_SHA`, then the
build-time `apps/api/build-info.json`, then `"unknown"`. When the service is
GitHub-connected, Railway injects `RAILWAY_GIT_COMMIT_SHA` automatically and no
manual step is needed. For an imperative `railway up` deploy (no Git metadata),
set `GIT_COMMIT_SHA` to the deployed commit so `/version` stays accurate.

The web static export ships as **committed bytes** in `apps/api/public`, which
the server resolves as a web root (`apps/api/src/server.js`). The deploy build
does NOT run `next build`: the constrained Railway NIXPACKS builder OOMs during
`next build`, and when the OOM-killer takes the whole build process tree the
deploy fails and Railway rolls back — freezing production on a stale image. By
serving the export as committed bytes, the deploy build is reduced to a tiny,
memory-trivial SHA stamp that cannot OOM, so every push actually deploys.

Freshness is a build-time concern: whoever changes `apps/web/**` rebuilds and
re-commits the export with `npm run build:web`, whose final stage mirrors
`apps/web/out` → `apps/api/public` (`scripts/sync-public-export.mjs`) so the
checked-in copy never drifts from source. To also rebuild it on the deploy host
(a CI runner with adequate memory), set `BUILD_WEB=1`; it stays non-fatal and
falls back to the committed export on failure.

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

Any of the server-side variables below that are present in the deploy
environment (sourced from the vault) are bound onto the `api` service in the same
run, each piped via `--stdin` so the value never lands in argv, logs, or the
repo. Absent ones are skipped, leaving the current value untouched:

| Variable                    | Consumer                              | Absent →                       |
| --------------------------- | ------------------------------------- | ------------------------------ |
| `SUPABASE_URL`              | `supabaseAdmin.js` + `GET /config`    | admin ops fail closed; **login blocked** |
| `SUPABASE_JWT_SECRET`       | `auth.js` (JWT verify) + anon mint    | `/me` stays `401`; no anon key to mint   |
| `SUPABASE_SERVICE_ROLE_KEY` | `supabaseAdmin.js` (admin ops)        | admin ops fail closed          |
| `ANTHROPIC_API_KEY`         | independent analysis (Fastify only)   | offline synthesizer (still cites real KPIs) |

The client-only `SUPABASE_ANON_KEY` is deliberately **not** set on the `api`
service — the server reaches Supabase with the service-role key, and the anon key
path is client-side only (see [`docs/env.md`](docs/env.md)).

### Unblocking magic-link login (BUG-1)

`GET /config` serves the browser its `{ supabaseUrl, supabaseAnonKey }` at
runtime (the committed static export can't inline `NEXT_PUBLIC_*`). The login
page only fires `POST {supabaseUrl}/auth/v1/otp` when **both** are non-empty;
otherwise it fails closed with a visible error and makes no request.

`SUPABASE_JWT_SECRET` is already bound on the `api` service (`/ready` →
`authSecret: true`), and the anon key **auto-mints from it** when a URL is
present (`publicConfig.js`). So the *single* remaining binding needed to make
login work end-to-end is **`SUPABASE_URL`** — the `https://<ref>.supabase.co`
project URL for ig-board's Supabase project. Bind it (never committed) via:

```bash
SUPABASE_URL=https://<ref>.supabase.co scripts/deploy-railway.sh   # value from the vault, out of band
```

Confirm afterward: `/ready` → `loginConfig: true`, and `GET /config` returns a
non-empty https `supabaseUrl` + `supabaseAnonKey` (with `Cache-Control:
no-store`). For full server-side admin ops (KPI data), also bind
`SUPABASE_SERVICE_ROLE_KEY` (flips `supabaseAdmin: true`). Provision these from
the ig-board Supabase project into the vault first if they are not present —
they are **not** synthesizable from anything already on the service, and no value
is ever hardcoded here.

No tokens, service-role keys, or Anthropic keys are stored in this repo or in
any deploy artifact — only public URLs and non-secret identifiers.
