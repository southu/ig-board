#!/usr/bin/env bash
# Imperative Railway deploy for the Boardroom API (`api` service, `ig-board`
# project, `production` env). Stamps the current git HEAD into GIT_COMMIT_SHA so
# /version reports the deployed commit even without Railway's Git metadata, then
# uploads and deploys the working tree.
#
# Requires: railway CLI authenticated via RAILWAY_API_TOKEN (never committed).
# Usage:    scripts/deploy-railway.sh   # run from a clean checkout of main
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

# Build + deploy the current directory; stream build logs then exit.
railway up --service "$SERVICE" --ci
echo "==> Deploy submitted for ${sha}"
