#!/usr/bin/env bash
# Live smoke checks for the deployed Boardroom API. Runs the public + auth
# regression checks that must hold on every deploy, plus the optional
# founder/board /me role checks when JWTs are supplied.
#
# Non-secret by design: it reads only the live URL and (optionally) JWTs that the
# operator exports out-of-band. No password, token, or key is ever committed,
# printed, or stored by this script. See TESTING.md and docs/env.md.
#
# Usage:
#   scripts/live-check.sh                       # public + 401 regression checks
#   FOUNDER_JWT=... BOARD_JWT=... scripts/live-check.sh   # also check /me roles
#
# Env:
#   BASE_URL     live base URL (default: https://ig-board-production.up.railway.app)
#   FOUNDER_JWT  optional Supabase access_token for the founder test user
#   BOARD_JWT    optional Supabase access_token for the board test user
set -euo pipefail

BASE_URL="${BASE_URL:-https://ig-board-production.up.railway.app}"
fail=0

pass() { printf 'ok   %s\n' "$1"; }
bad()  { printf 'FAIL %s\n' "$1" >&2; fail=1; }

status() { curl -s -o /dev/null -w '%{http_code}' "$@"; }

# 1. /health -> 200
[ "$(status "$BASE_URL/health")" = "200" ] \
  && pass "GET /health -> 200" || bad "GET /health did not return 200"

# 2. /version -> 200 and reports a 40-char git SHA.
ver_code="$(status "$BASE_URL/version")"
ver_sha="$(curl -fsS "$BASE_URL/version" 2>/dev/null \
  | sed -n 's/.*"sha":"\([0-9a-f]\{7,40\}\)".*/\1/p')"
if [ "$ver_code" = "200" ] && [ -n "$ver_sha" ]; then
  pass "GET /version -> 200 (sha=$ver_sha)"
else
  bad "GET /version did not return 200 with a sha"
fi

# 2b. If we can see origin/main locally, verify the deployed sha matches it.
if git rev-parse --verify -q origin/main >/dev/null 2>&1; then
  origin_sha="$(git rev-parse origin/main)"
  case "$origin_sha" in
    "$ver_sha"*) pass "deployed sha matches origin/main" ;;
    *) bad "deployed sha $ver_sha != origin/main $origin_sha (deploy may be in flight)" ;;
  esac
fi

# 2c. /ready -> 200 with non-secret booleans. Always 200 (never fails closed);
# the ready/checks flags report whether the vault-provisioned server env is bound.
# Printed informationally — an unbound env does not fail the smoke run. The
# per-check booleans confirm (without any value) that the vault provision reached
# the api service: authSecret gates /me; supabaseAdmin confirms the server-side
# SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY path; anthropic is informational.
if [ "$(status "$BASE_URL/ready")" = "200" ]; then
  ready_body="$(curl -fsS "$BASE_URL/ready" 2>/dev/null || true)"
  bool() { printf '%s' "$ready_body" | sed -n "s/.*\"$1\":\(true\|false\).*/\1/p"; }
  ready_state="$(bool ready)"
  pass "GET /ready -> 200 (ready=${ready_state:-?} authSecret=$(bool authSecret) supabaseAdmin=$(bool supabaseAdmin) anthropic=$(bool anthropic))"
else
  bad "GET /ready did not return 200"
fi

# 3. Auth boundary fails closed: no token and garbage token both -> 401.
[ "$(status "$BASE_URL/me")" = "401" ] \
  && pass "GET /me (no token) -> 401" || bad "GET /me without a token was not 401"
[ "$(status -H 'Authorization: Bearer garbage' "$BASE_URL/me")" = "401" ] \
  && pass "GET /me (garbage token) -> 401" || bad "GET /me with a garbage token was not 401"

# 4. Optional: authenticated role mapping. JWTs may be supplied out-of-band
# (FOUNDER_JWT / BOARD_JWT). Otherwise, if the service-role env is exported, mint
# them server-side via the documented scripts/mint-test-jwt.mjs path so the full
# role check runs from a single command. Minted tokens stay in this shell only —
# never printed or stored (mint writes the token to stdout, diagnostics to stderr).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
mint_jwt() { # $1: --founder|--board -> echoes an access_token, or nothing on failure
  node "$SCRIPT_DIR/mint-test-jwt.mjs" "$1" 2>/dev/null || true
}
if [ -n "${SUPABASE_URL:-}" ] && [ -n "${SUPABASE_SERVICE_ROLE_KEY:-}" ] \
   && [ -f "$SCRIPT_DIR/mint-test-jwt.mjs" ]; then
  [ -n "${FOUNDER_JWT:-}" ] || FOUNDER_JWT="$(mint_jwt --founder)"
  [ -n "${BOARD_JWT:-}" ]   || BOARD_JWT="$(mint_jwt --board)"
fi

check_role() {
  local label="$1" jwt="$2" want="$3"
  [ -n "$jwt" ] || { printf 'skip %s /me (no %s JWT provided)\n' "$label" "$label"; return; }
  local got
  got="$(curl -fsS -H "Authorization: Bearer $jwt" "$BASE_URL/me" 2>/dev/null \
    | sed -n 's/.*"role":"\([a-z]*\)".*/\1/p')"
  [ "$got" = "$want" ] \
    && pass "$label /me -> role $want" \
    || bad "$label /me returned role '${got:-<none>}', wanted $want"
}
check_role founder "${FOUNDER_JWT:-}" founder
check_role board "${BOARD_JWT:-}" board

if [ "$fail" -ne 0 ]; then
  echo "== live-check: FAILED ==" >&2
  exit 1
fi
echo "== live-check: all checks passed =="
