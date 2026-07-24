#!/usr/bin/env bash
# Live smoke checks for the deployed Boardroom service. Runs the web-shell
# HTML surface (/, /login), public + auth API regression checks that must
# hold on every deploy, plus the optional founder/board /me role checks when
# JWTs are supplied.
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

# 0. Web shell (same origin as the API): browser GET / and /login must return
# HTML, not API JSON. Matches mission ig-board-web-shell acceptance criteria.
browser_headers=(-H 'Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' -H 'User-Agent: Mozilla/5.0')

root_headers="$(mktemp)"
root_body="$(mktemp)"
root_code="$(curl -sS -D "$root_headers" -o "$root_body" -w '%{http_code}' "${browser_headers[@]}" "$BASE_URL/" || true)"
root_ctype="$(grep -i '^content-type:' "$root_headers" | head -1 | tr -d '\r' || true)"
if [ "$root_code" = "200" ] && echo "$root_ctype" | grep -qi 'text/html' && grep -qi '<html' "$root_body"; then
  pass "GET / -> 200 text/html with <html (app shell)"
elif [ "$root_code" -ge 300 ] 2>/dev/null && [ "$root_code" -lt 400 ] 2>/dev/null; then
  loc="$(grep -i '^location:' "$root_headers" | head -1 | sed 's/^[Ll]ocation:[[:space:]]*//' | tr -d '\r')"
  case "$loc" in
    */login|*/login/*|/login|/login/*|"$BASE_URL/login"|"$BASE_URL/login/"*)
      pass "GET / -> ${root_code} redirect to /login ($loc)"
      ;;
    *)
      bad "GET / redirected to unexpected Location: ${loc:-<none>}"
      ;;
  esac
else
  bad "GET / did not return HTML 200 or redirect to /login (code=$root_code ctype=$root_ctype)"
fi
rm -f "$root_headers" "$root_body"

login_headers="$(mktemp)"
login_body="$(mktemp)"
login_code="$(curl -sS -D "$login_headers" -o "$login_body" -w '%{http_code}' "${browser_headers[@]}" "$BASE_URL/login" || true)"
login_ctype="$(grep -i '^content-type:' "$login_headers" | head -1 | tr -d '\r' || true)"
if [ "$login_code" = "200" ] && echo "$login_ctype" | grep -qi 'text/html' && grep -qi '<html' "$login_body" \
   && grep -qiE 'login|sign[[:space:]-]?in|<form|type="password"|type="email"' "$login_body"; then
  pass "GET /login -> 200 text/html with login UI"
else
  bad "GET /login did not return 200 HTML login page (code=$login_code ctype=$login_ctype)"
fi
rm -f "$login_headers" "$login_body"

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

# 2c. /ready -> 200 with non-secret booleans only. Always 200 (never fails closed);
# checks report whether vault-provisioned env is bound: jwt_secret_set,
# supabase_url_set, supabase_key_set, db_reachable. Values never appear.
if [ "$(status "$BASE_URL/ready")" = "200" ]; then
  ready_body="$(curl -fsS "$BASE_URL/ready" 2>/dev/null || true)"
  bool() { printf '%s' "$ready_body" | sed -n "s/.*\"$1\":\(true\|false\).*/\1/p"; }
  ready_state="$(bool ready)"
  pass "GET /ready -> 200 (ready=${ready_state:-?} jwt_secret_set=$(bool jwt_secret_set) supabase_url_set=$(bool supabase_url_set) supabase_key_set=$(bool supabase_key_set) db_reachable=$(bool db_reachable))"
else
  bad "GET /ready did not return 200"
fi

# 3. Auth boundary fails closed: no token and garbage token both -> 401.
[ "$(status "$BASE_URL/me")" = "401" ] \
  && pass "GET /me (no token) -> 401" || bad "GET /me without a token was not 401"
[ "$(status -H 'Authorization: Bearer garbage' "$BASE_URL/me")" = "401" ] \
  && pass "GET /me (garbage token) -> 401" || bad "GET /me with a garbage token was not 401"

# 4. Optional: authenticated role mapping. JWTs may be supplied out-of-band
# (FOUNDER_JWT / BOARD_JWT). Otherwise mint them from the documented scripts so
# the full role check runs from a single command. Two mint paths, tried in order:
#   a) service-role admin path (scripts/mint-test-jwt.mjs) — needs SUPABASE_URL +
#      SUPABASE_SERVICE_ROLE_KEY and a reachable Supabase project.
#   a2) offline path (scripts/mint-jwt-offline.mjs) — needs only SUPABASE_JWT_SECRET
#      (/ready jwt_secret_set); signs the token directly, no project or npm deps required.
# Minted tokens stay in this shell only — never printed or stored (mint writes the
# token to stdout, diagnostics to stderr).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
mint_admin()   { node "$SCRIPT_DIR/mint-test-jwt.mjs" "$1" 2>/dev/null || true; }
mint_offline() { node "$SCRIPT_DIR/mint-jwt-offline.mjs" "$1" 2>/dev/null || true; }
if [ -n "${SUPABASE_URL:-}" ] && [ -n "${SUPABASE_SERVICE_ROLE_KEY:-}" ] \
   && [ -f "$SCRIPT_DIR/mint-test-jwt.mjs" ]; then
  [ -n "${FOUNDER_JWT:-}" ] || FOUNDER_JWT="$(mint_admin --founder)"
  [ -n "${BOARD_JWT:-}" ]   || BOARD_JWT="$(mint_admin --board)"
fi
# Fall back to the offline JWT-secret path for any token still missing.
if [ -n "${SUPABASE_JWT_SECRET:-${JWT_SECRET:-}}" ] && [ -f "$SCRIPT_DIR/mint-jwt-offline.mjs" ]; then
  [ -n "${FOUNDER_JWT:-}" ] || FOUNDER_JWT="$(mint_offline --founder)"
  [ -n "${BOARD_JWT:-}" ]   || BOARD_JWT="$(mint_offline --board)"
fi

check_role() {
  local label="$1" jwt="$2" want="$3"
  [ -n "$jwt" ] || { printf 'skip %s /me (no %s JWT provided)\n' "$label" "$label"; return; }
  local got
  got="$(curl -fsS -H "Authorization: Bearer $jwt" "$BASE_URL/me" 2>/dev/null \
    | sed -n 's/.*"role":"\([a-z_]*\)".*/\1/p')"
  [ "$got" = "$want" ] \
    && pass "$label /me -> role $want" \
    || bad "$label /me returned role '${got:-<none>}', wanted $want"
}
# FOUNDER_JWT / BOARD_JWT env names kept for operators; exposed roles are
# governance names admin | board_member (see apps/api/src/permissions.js).
check_role admin "${FOUNDER_JWT:-${ADMIN_JWT:-}}" admin
check_role board_member "${BOARD_JWT:-${BOARD_MEMBER_JWT:-}}" board_member

if [ "$fail" -ne 0 ]; then
  echo "== live-check: FAILED ==" >&2
  exit 1
fi
echo "== live-check: all checks passed =="
