# Queue Builder goal — Boardroom (ig-board) live scorecard UI

**Use:** On Build, set folder **`ig-board`**, turn **Provision ON**, and paste the short pointer below (or tell the planner to read this file). Do not ask clarifying questions; draft the ordered steps from this document.

**Short paste for Build (if you cannot paste this whole file):**

```text
Folder: ig-board. Provision ON. Draft immediately (phase=draft). Do NOT ask clarifying questions.
Read and follow the full goal specification at:
/opt/projects/ig-board/QUEUE-BUILDER-GOAL-scorecard-ui.md
Produce exactly 8 ordered queue steps as specified in that file. ready_to_confirm true when done.
```

---

Folder: **ig-board**. Draft immediately (`phase=draft`). Do **NOT** ask clarifying questions. Produce **exactly 8 ordered queue steps** (not one mega-mission). Each step request must be a full plain-language mission with repo, live URL, constraints, provisioning rules, and explicit **Done when**. Order by dependency. Deploy each step via `main`; after every deploy confirm `GET {live_url}/version` returns HTTP 200 and a git SHA that matches `origin/main` HEAD (or is a descendant of the commit just pushed). Never invent laptop paths. Never put secrets, tokens, connection strings, JWTs, or API keys in mission text, commits, client code, or logs.

## PROJECT (authoritative)

| Field | Value |
|--------|--------|
| project_folder | `ig-board` |
| product name | **Boardroom** — private governance scorecard for **The Image Group** (board + founders) |
| repo | https://github.com/southu/ig-board.git |
| live_url | https://ig-board-production.up.railway.app |
| version_endpoint | `/version` |
| deploy branch | `main` |
| Railway | Project **already exists** and is bound in project.json (`railway_project` UUID `cfd460dc-0744-43d6-a96a-336da96ffdf6`). **REUSE ONLY** — do not create a second Railway project, do not destroy services. Service **`api`** is public at the live_url (port 8080). |
| GitHub SoT | Builder always clones/pushes GitHub. `/opt/projects/ig-board` may be stale; never treat a stale local shell as truth. |

## CURRENT REALITY (do not re-discover incorrectly)

**Already done (do not rebuild from scratch):**

- Monorepo: `apps/api` (Fastify), `apps/web` (Next stub only), `supabase/` migrations + seed + RLS
- Live API responds: `GET /health` → 200 `{"status":"ok"}`; `GET /version` → 200 with sha
- Auth boundary on API: most routes require Bearer JWT; public `/` returns 401 by design
- Schema/seed/RLS foundation and API scaffold missions **succeeded**

**Broken / blocked (must fix early in the plan):**

- **Railway deploy lag:** GitHub `main` is often **ahead** of live `/version` SHA. A recent env mission failed with **deploy-timeout** (wanted newer SHA; live stuck on older). Every UI step must include a **reliable deploy path** (GitHub-connected auto-deploy **or** documented `scripts/deploy-railway.sh` / imperative deploy) so live SHA actually advances.
- **No scorecard UI on the live host yet.** `apps/web` is a placeholder. Opening the apex live URL shows API JSON 401 — operators need a **browser UI** at the same host (or clearly documented same-origin paths).
- **env-test-accounts** may still be failed/queued behind: Supabase + Railway env vars (names only in docs; values only Vault → Railway). Fix deploy + env **before** deep UI auth flows.

**Non-goals for this campaign:**

- Public marketing site, self-signup, password auth
- Second deploy host (no separate Cloudflare Pages **required** for acceptance — prefer **one** live_url serving API + static web)
- Replacing schema/seed from zero; extend what exists
- Putting secrets in the repo or mission YAML

## PRODUCT (what “done” means for humans)

Boardroom is an **invite-only board scorecard**:

1. Founders + board open a **URL in the browser** (not curl).
2. **Only public page is `/login`** (magic link / invite email — no password, no register).
3. After auth: **home = five-layer pyramid** (MANAGE layers 1–3, MONITOR 4–5); band color = worst RAG in layer from live KPI data (or elegant empty gray).
4. Drill into a layer → **KPI cards** (value, target, sparkline, RAG, owner).
5. **Founder** can enter/update KPI values + definitions; **board** is read-only on values.
6. Theme: light/dark boardroom (no flash on reload); professional, not marketing chrome.

Operator “I can use it” bar for **this 8-step campaign**:

- Visit live_url → **login UI** (not raw 401 JSON as the only experience for humans).
- Log in as test founder or board (documented emails/roles; secrets never in repo).
- See **pyramid dashboard** and at least one **layer detail** with seeded KPI structure (values may be empty but UI must render).

## PROVISIONING (include on every step; Provision ON)

- `architect.enabled: true` (tools: none)
- `provision.enabled: true`, provider `railway`, project_name `ig-board`
- allowlist `project_names: [ig-board]`, create_project true only if missing (prefer reuse bound id), destroy false
- Fail closed on `vault_locked` / `consumer_not_armed` / `vault_access_denied`
- Secrets only via Vault → Railway env (names documented in `docs/env.md` / `DEPLOY.md`). Builder uses non-secret provision summary only.
- Required **names** (values never in missions):  
  `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_JWT_SECRET`, plus any `NEXT_PUBLIC_*` needed for the web client at build time if static export embeds public config carefully (prefer runtime config from API `/ready` or server injection so secrets stay server-side).

## DEPLOY RULES (critical — this is why UI “isn’t live”)

1. **One live_url** for acceptance: `https://ig-board-production.up.railway.app`
2. Fastify **`api` service must serve**:
   - Existing API routes (`/health`, `/version`, auth routes, KPI APIs as built)
   - **Static export of `apps/web`** (or equivalent) so browsers get HTML for `/`, `/login`, app routes — not only JSON 401 on `/`
3. After every push: poll `GET {live_url}/version` until SHA matches the pushed commit (or descendant). If deploy does not advance within timeout, **stop and fix Railway wiring** (source repo/branch, build/start, root directory, failed build logs) — do **not** thrash full rebuilds of product features.
4. Prefer fixing **auto-deploy from GitHub `main`** so push == deploy. Document in `DEPLOY.md` if imperative deploy remains required.
5. Never rely on `https://ig-board.up.railway.app` (404). Never invent a second production domain unless operator adds it.

## EXACTLY 8 ORDERED STEPS

Each step = one queue item. Title the missions clearly. Every step: commit + push `main`; live `/version` gate; no secrets in git.

### Step 1 — Railway deploy truth + live SHA catch-up

**Goal:** Live `/version` SHA matches `origin/main` HEAD after a controlled no-op or minimal ship. Prove GitHub→Railway path works.

**Done when:**

- `GET {live_url}/health` 200
- `GET {live_url}/version` 200 and SHA equals (or is descendant of) current `origin/main` after the step’s push
- `DEPLOY.md` states how deploy is triggered (GitHub auto vs script) and which service/domain is authoritative
- No product UI required yet

### Step 2 — Vault/Railway env + test principals (unblock auth)

**Goal:** Server has Supabase + JWT env bound on Railway (from Vault). Document founder + board invite-only test users (emails/roles only). Seed/admin path for creating them without committing secrets.

**Done when:**

- `GET {live_url}/ready` is public and returns JSON with boolean checks only (no secret values) — or documented equivalent readiness if already named differently; align with latest main
- `TESTING.md` lists founder + board test emails/roles and how to obtain a session for live checks (no passwords/tokens in repo)
- `GET {live_url}/me` with a valid founder JWT → role founder; board JWT → board (prove once in evidence without storing tokens in git)
- Live `/version` still tracks main

### Step 3 — Serve web UI from the same live_url (shell + routing)

**Goal:** Humans opening `{live_url}/` get **HTML**, not only API JSON. Ship Next.js App Router static export (or SSR if already chosen) built into the Railway `api` service (or co-located service on **same host**).

**Done when:**

- Browser `GET {live_url}/` returns HTML content-type (or redirect to `/login`)
- `GET {live_url}/login` returns the login page HTML 200
- API `GET {live_url}/health` and `/version` still 200
- Client never embeds service-role or JWT secret

### Step 4 — Invite-only auth + theme foundation

**Goal:** Magic-link (or Supabase invite) login; auth guard on all non-login routes; light/dark boardroom theme with no flash; theme toggle persists.

**Done when:**

- Unauthenticated visit to a protected app path redirects to `/login`
- Authenticated session can reach a post-login shell (even if pyramid is placeholder)
- Theme tokens + toggle work; hard reload does not flash wrong theme
- Live `/version` gate green

### Step 5 — Pyramid home (scorecard hero)

**Goal:** Authenticated home shows **five-layer pyramid** (MANAGE 1–3, MONITOR 4–5); band color from worst KPI status in layer (or gray empty state). Data from API/Supabase via server or authorized client with **anon + user JWT only**.

**Done when:**

- Logged-in founder or board sees pyramid on home
- Layers labeled MANAGE/MONITOR correctly
- Empty data is intentional and readable in light and dark
- Live `/version` gate green

### Step 6 — Layer detail + KPI cards

**Goal:** Open a layer → KPI cards with value/target/sparkline/RAG/owner/last-updated (Recharts or equivalent). Navigation from pyramid bands.

**Done when:**

- At least one layer detail route is reachable from the pyramid
- Seeded KPI **structure** visible (values may be null)
- Sparklines/RAG use theme tokens
- Live `/version` gate green

### Step 7 — Founder write path + board read-only + audit

**Goal:** Founder can enter/update KPI values (and definitions if already in schema); board cannot write (UI + API/RLS). Changes write `audit_log`.

**Done when:**

- Founder can submit a value and see it reflected after reload
- Board has no write controls; write API returns 401/403
- Audit trail recorded for value changes
- Live `/version` gate green

### Step 8 — Live smoke + operator runbook

**Goal:** Document how an operator uses Boardroom day-to-day; Playwright or scripted smoke against **live** for login redirect, pyramid visible, founder write, board read-only; fix deploy flake notes.

**Done when:**

- `TESTING.md` or `docs/operator-smoke.md` has a 5-minute path: open URL → login → pyramid → layer → (founder) update
- Automated smoke in-repo passes against live_url where credentials are injected only via env/Vault in CI/operator machine — never committed
- Live `/version` matches main; `/health` 200
- Campaign “operator can use the scorecard in a browser” is true

## ACCEPTANCE THEMES (repeat per step as relevant)

- Live URL always `https://ig-board-production.up.railway.app`
- `GET /health` 200; `GET /version` 200 with SHA tied to the step’s deploy
- No `sk-` / service-role / JWT secrets in repo or page source
- Do not wipe `supabase/` migrations or break existing RLS intent
- Prefer extending `apps/web` + `apps/api`; do not create a second product repo

## OPERATOR PREP (outside the expander — do before or during step 2)

1. Supabase project for Boardroom (or confirm existing).
2. Vault folder `ig-board`: labels for URL, anon, service role, JWT secret (values never in chat/missions).
3. Railway service env bound from Vault; redeploy.
4. Create invite-only founder + board users in Supabase Auth.
5. Confirm Railway **auto-deploy from GitHub `main`** or use the repo deploy script until auto-deploy works.

## OUT OF SCOPE (later campaigns)

- AI analyses, memo upload pipeline polish, agenda Phase 3, Phase 4 CSV/whats-new polish, mobile visual polish — may already exist as later queue items; this 8-step plan is the **minimum path to a usable live scorecard UI**. If those later missions still sit queued after a failed env step, **close or requeue the failed head first**, or replace the folder queue with this campaign after operator OK.

## PLANNER OUTPUT FORMAT

For each of the 8 steps output a queue request that includes:

- Goal in plain language  
- Repo + live_url + version gate  
- Provision block (Railway ig-board, fail closed)  
- Explicit non-goals  
- **Done when** bullets that a tester can curl/browser-check without secrets in the mission text  

`ready_to_confirm: true` when all 8 are drafted.
