#!/usr/bin/env bash
# Imperative Railway deploy for the Boardroom API (`api` service, `ig-board`
# project, `production` env). Stamps the current git HEAD into GIT_COMMIT_SHA so
# /version reports the deployed commit even without Railway's Git metadata, then
# uploads and deploys the working tree.
#
# Requires: railway CLI authenticated via RAILWAY_API_TOKEN (never committed).
# Optional: export any of the server-side vars below (sourced from the vault)
#           before running to bind them onto the `api` service; each is set only
#           when present, so omitting one leaves the existing value unchanged:
#             SUPABASE_URL, SUPABASE_JWT_SECRET, SUPABASE_SERVICE_ROLE_KEY,
#             ANTHROPIC_API_KEY.
#           The client-only SUPABASE_ANON_KEY is intentionally NOT set on `api`
#           (it belongs to the web service — see docs/env.md).
# Usage:    SUPABASE_URL=... SUPABASE_JWT_SECRET=... SUPABASE_SERVICE_ROLE_KEY=... \
#             scripts/deploy-railway.sh                          # from a clean main
set -euo pipefail

PROJECT_ID="cfd460dc-0744-43d6-a96a-336da96ffdf6"   # ig-board (non-secret id)
SERVICE="api"
ENVIRONMENT="production"

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$here"

sha="$(git rev-parse HEAD)"
echo "==> Deploying ig-board/api @ ${sha}"

railway link --project "$PROJECT_ID" --environment "$ENVIRONMENT" --service "$SERVICE" >/dev/null

# Stamp the deployed commit so /version is accurate for imperative deploys.
railway variable set "GIT_COMMIT_SHA=${sha}" --service "$SERVICE" --skip-deploys >/dev/null
echo "==> GIT_COMMIT_SHA set on service '${SERVICE}'"

# Bind a server-side variable onto the `api` service from the deploy environment.
# The value is supplied out-of-band (vault / CI secret) and is NEVER committed
# here; it is piped via --stdin so it never appears in argv or process listings,
# and --skip-deploys batches every set into the single `railway up` below. A var
# that is absent from the deploy env is skipped (existing value left unchanged),
# with a warning when omitting it degrades a feature.
set_service_var() {
  local name="$1" warn="${2:-}"
  local value="${!name:-}"
  if [ -n "$value" ]; then
    printf '%s' "$value" \
      | railway variable set "$name" --stdin --service "$SERVICE" --skip-deploys >/dev/null
    echo "==> ${name} set on service '${SERVICE}' (value sourced from deploy env)"
  elif [ -n "$warn" ]; then
    echo "==> WARNING: ${warn}" >&2
  fi
}

# Supabase project URL — server-side admin ops (apps/api/src/supabaseAdmin.js).
set_service_var SUPABASE_URL \
  "SUPABASE_URL not in deploy env — server-side Supabase admin ops fail closed until it is set"
# HMAC "JWT Secret" (NOT the service-role key) — verifies Supabase HS256 tokens.
# Without it every authenticated route fails closed (401) — see apps/api/src/auth.js.
set_service_var SUPABASE_JWT_SECRET \
  "SUPABASE_JWT_SECRET not in deploy env — /me stays 401 until it is set"
# Service-role key — server-only privileged (RLS-bypassing) admin access. Never
# sent to a browser; used only by apps/api/src/supabaseAdmin.js.
set_service_var SUPABASE_SERVICE_ROLE_KEY \
  "SUPABASE_SERVICE_ROLE_KEY not in deploy env — server-side admin ops fail closed until it is set"
# Anthropic provider key — server-only; optional until the analyst mission wires it.
set_service_var ANTHROPIC_API_KEY

# Build + deploy the current directory; stream build logs then exit. The deploy
# picks up the service variables set above (GIT_COMMIT_SHA + the Supabase/Anthropic
# server-side vars that were present in the deploy env).
railway up --service "$SERVICE" --ci
echo "==> Deploy submitted for ${sha}"
