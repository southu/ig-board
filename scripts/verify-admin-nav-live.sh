#!/usr/bin/env bash
# Live re-verify for admin-nav / logout / jasonharper admin.
# No passwords/secrets: self-hosted OTP returns inline action_link.
set -euo pipefail
LIVE="${LIVE_URL:-https://ig-board-production.up.railway.app}"
LIVE="${LIVE%/}"
need() { command -v "$1" >/dev/null || { echo "missing $1" >&2; exit 2; }; }
need curl; need python3

ANON=$(curl -fsS "$LIVE/config" | python3 -c 'import sys,json;print(json.load(sys.stdin)["supabaseAnonKey"])')

login() {
  local email="$1" raw link out token
  raw=$(curl -fsS -X POST "$LIVE/auth/v1/otp" \
    -H "apikey: $ANON" -H "Content-Type: application/json" \
    -d "{\"email\":\"$email\",\"create_user\":false}")
  link=$(printf '%s' "$raw" | python3 -c 'import sys,json;print(json.load(sys.stdin)["action_link"])')
  # verify may 302; do not use curl -f
  out=$(curl -sS -i --max-time 30 "$link")
  token=$(printf '%s' "$out" | python3 -c 'import sys,re;t=sys.stdin.read();
m=re.search(r"\"access_token\"\s*:\s*\"([^\"]+)\"",t) or re.search(r"access_token=([^;\s&]+)",t);
print(m.group(1) if m else "")')
  [[ -n "$token" ]] || { echo "FAIL: no access_token for $email" >&2; echo "$out" | head -c 400 >&2; exit 1; }
  printf '%s' "$token"
}

echo "== live $LIVE =="
VER=$(curl -fsS "$LIVE/version")
SHA=$(printf '%s' "$VER" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("sha",""))')
echo "version sha=$SHA"
curl -fsS -o /dev/null -w "health %{http_code}\n" "$LIVE/health"

echo "-- jason@jasonharper.com --"
TOK=$(login 'jason@jasonharper.com')
ME=$(curl -fsS "$LIVE/me" -H "Authorization: Bearer $TOK" -H "apikey: $ANON")
echo "$ME" | python3 -c 'import sys,json;d=json.load(sys.stdin);assert d.get("role")=="admin",d;assert "access_admin_area" in d.get("capabilities",[]),d;print("me OK role=admin caps=access_admin_area")'
code=$(curl -sS -o /tmp/au.json -w '%{http_code}' "$LIVE/api/admin/users" -H "Authorization: Bearer $TOK" -H "apikey: $ANON")
[[ "$code" == "200" ]] || { echo "FAIL admin users $code"; exit 1; }
python3 -c 'import json;u=json.load(open("/tmp/au.json"))["users"];roles={x["email"]:x["role"] for x in u};assert roles.get("jason@jasonharper.com")=="admin",roles;print("admin list OK jasonharper=admin")'
code=$(curl -sS -o /dev/null -w '%{http_code}' "$LIVE/admin" -H "Authorization: Bearer $TOK" -H "apikey: $ANON")
[[ "$code" == "200" ]] || { echo "FAIL /admin $code"; exit 1; }
echo "/admin OK 200"
curl -sS -X POST "$LIVE/auth/v1/logout" -H "Authorization: Bearer $TOK" -H "apikey: $ANON" -o /dev/null -w "logout %{http_code}\n"
code=$(curl -sS -o /dev/null -w '%{http_code}' "$LIVE/me" -H "Authorization: Bearer $TOK" -H "apikey: $ANON")
[[ "$code" == "401" ]] || { echo "FAIL post-logout /me $code"; exit 1; }
echo "post-logout /me OK 401"

echo "-- ratchet-employee@boardroom.test --"
TOK=$(login 'ratchet-employee@boardroom.test')
ME=$(curl -fsS "$LIVE/me" -H "Authorization: Bearer $TOK" -H "apikey: $ANON")
echo "$ME" | python3 -c 'import sys,json;d=json.load(sys.stdin);assert d.get("role")=="employee",d;assert "access_admin_area" not in d.get("capabilities",[]);print("me OK role=employee no access_admin_area")'
code=$(curl -sS -o /dev/null -w '%{http_code}' "$LIVE/api/admin/users" -H "Authorization: Bearer $TOK" -H "apikey: $ANON")
[[ "$code" == "403" ]] || { echo "FAIL employee admin users $code"; exit 1; }
echo "employee /api/admin/users OK 403"
code=$(curl -sS -o /dev/null -w '%{http_code}' "$LIVE/admin" -H "Authorization: Bearer $TOK" -H "apikey: $ANON")
[[ "$code" == "403" ]] || { echo "FAIL employee /admin $code"; exit 1; }
echo "employee /admin OK 403"

echo "ALL LIVE CHECKS PASSED sha=$SHA"
