#!/usr/bin/env bash
# Imperative Railway deploy for the Boardroom API (`api` service, `ig-board`
# project, `production` env). Stamps the current git HEAD into GIT_COMMIT_SHA so
# /version reports the deployed commit even without Railway's Git metadata, then
# uploads and deploys the working tree.
#
# Requires: railway CLI authenticated via RAILWAY_API_TOKEN (never committed).
# Optional: export SUPABASE_JWT_SECRET (from the vault) before running to set the
#           API's JWT signing secret on the service; omit to leave it unchanged.
# Usage:    SUPABASE_JWT_SECRET=... scripts/deploy-railway.sh   # from a clean main
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

# Inject the Supabase JWT signing secret (HMAC "JWT Secret", NOT the service-role
# key) so the API can verify Supabase tokens. The value is supplied out-of-band
# by the deploy environment (vault / CI secret) and is NEVER committed here. It
# is piped via --stdin so the secret never appears in argv or process listings.
# Without it, every authenticated route fails closed (401) — see apps/api/src/auth.js.
if [ -n "${SUPABASE_JWT_SECRET:-}" ]; then
  printf '%s' "$SUPABASE_JWT_SECRET" \
    | railway variable set SUPABASE_JWT_SECRET --stdin --service "$SERVICE" --skip-deploys >/dev/null
  echo "==> SUPABASE_JWT_SECRET set on service '${SERVICE}' (value sourced from deploy env)"
else
  echo "==> WARNING: SUPABASE_JWT_SECRET not in deploy env — /me stays 401 until it is set" >&2
fi

# Build + deploy the current directory; stream build logs then exit. The deploy
# picks up the service variables set above (GIT_COMMIT_SHA + SUPABASE_JWT_SECRET).
railway up --service "$SERVICE" --ci
echo "==> Deploy submitted for ${sha}"
