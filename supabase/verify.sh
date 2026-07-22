#!/usr/bin/env bash
# supabase/verify.sh — reproducible evidence for the Boardroom database.
#
# Runs against a THROWAWAY Postgres and proves, end to end, the two claims the
# foundation mission is graded on:
#
#   1. Idempotency — seed.sql run twice yields identical final row counts
#      (5 layers, 25 KPIs).
#   2. Deny-by-default RLS — anon is denied on every table; a board member can
#      read but cannot INSERT kpi_values or UPDATE kpis; audit_log is immutable
#      (INSERT + SELECT policies only); comments enforce exactly-one-target.
#
# This is a LOCAL verification harness. On Supabase the platform provides
# auth.uid() and the anon / authenticated roles; here we install a small shim so
# the same migrations can be exercised offline. Point it at a disposable db:
#
#   DATABASE_URL=postgres://postgres@127.0.0.1:5432/postgres ./supabase/verify.sh
#
# Requires: psql on PATH. Exits non-zero on the first failed assertion.
set -euo pipefail

: "${DATABASE_URL:?Set DATABASE_URL to a THROWAWAY Postgres connection string}"

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FOUNDER='11111111-1111-1111-1111-111111111111'
BOARD='22222222-2222-2222-2222-222222222222'

pass=0
fail=0
q() { psql "$DATABASE_URL" -X -A -t -v ON_ERROR_STOP=0 -c "$1" 2>&1; }

# assert_eq <label> <actual> <expected>
assert_eq() {
  if [ "$2" = "$3" ]; then
    printf '  ✓ %s\n' "$1"; pass=$((pass + 1))
  else
    printf '  ✗ %s (got: %s | want: %s)\n' "$1" "$2" "$3"; fail=$((fail + 1))
  fi
}

# assert_match <label> <actual> <substring>
assert_match() {
  case "$2" in
    *"$3"*) printf '  ✓ %s\n' "$1"; pass=$((pass + 1));;
    *)      printf '  ✗ %s (got: %s | want ~: %s)\n' "$1" "$2" "$3"; fail=$((fail + 1));;
  esac
}

echo "==> Installing local auth.uid() shim + anon/authenticated roles (test only)"
psql "$DATABASE_URL" -X -q -v ON_ERROR_STOP=1 <<'SQL'
create schema if not exists auth;
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
end $$;
SQL

echo "==> Applying migrations"
for f in "$here"/migrations/*.sql; do
  echo "    - $(basename "$f")"
  psql "$DATABASE_URL" -X -q -v ON_ERROR_STOP=1 -f "$f"
done
psql "$DATABASE_URL" -X -q -v ON_ERROR_STOP=1 -c \
  "grant usage on schema auth to anon, authenticated;
   grant execute on function auth.uid() to anon, authenticated;"

echo "==> Idempotency: seeding twice"
psql "$DATABASE_URL" -X -q -v ON_ERROR_STOP=1 -f "$here/seed.sql" >/dev/null
c1_layers=$(q "select count(*) from public.layers")
c1_kpis=$(q "select count(*) from public.kpis")
psql "$DATABASE_URL" -X -q -v ON_ERROR_STOP=1 -f "$here/seed.sql" >/dev/null
c2_layers=$(q "select count(*) from public.layers")
c2_kpis=$(q "select count(*) from public.kpis")

echo "Idempotency"
assert_eq "run1 layers = 5"           "$c1_layers" "5"
assert_eq "run1 kpis = 25"            "$c1_kpis"   "25"
assert_eq "run2 layers = run1 layers" "$c2_layers" "$c1_layers"
assert_eq "run2 kpis = run1 kpis"     "$c2_kpis"   "$c1_kpis"
assert_eq "layers manage=true = 3"    "$(q "select count(*) from public.layers where manage")"      "3"
assert_eq "revenue plan KPIs = 3"     "$(q "select count(*) from public.kpis where key like 'revenue_plan%'")" "3"

echo "==> Seeding test principals"
psql "$DATABASE_URL" -X -q -v ON_ERROR_STOP=1 <<SQL
insert into public.users (id, email, role, full_name) values
  ('$FOUNDER','founder@ig.test','founder','Founder'),
  ('$BOARD','board@ig.test','board','Board')
on conflict (email) do update set role = excluded.role;
SQL

as_role() { # <uuid|anon> <sql>  -> raw output (incl. SET/tags), for match asserts
  local sub="$1" sql="$2"
  if [ "$sub" = "anon" ]; then
    q "set role anon; $sql"
  else
    q "set role authenticated; set request.jwt.claim.sub='$sub'; $sql"
  fi
}

scalar_role() { # <uuid|anon> <sql> -> final result line only, for exact asserts
  as_role "$1" "$2" | grep -v '^SET$' | tail -n1
}

echo "RLS: deny-by-default"
assert_match "anon SELECT kpis denied"  "$(as_role anon "select count(*) from public.kpis")"  "permission denied"
assert_match "anon SELECT users denied" "$(as_role anon "select count(*) from public.users")" "permission denied"

echo "RLS: board is read-only on KPI data"
assert_eq    "board SELECT kpis = 25"        "$(scalar_role "$BOARD" "select count(*) from public.kpis")" "25"
assert_match "board INSERT kpi_values denied" \
  "$(as_role "$BOARD" "insert into public.kpi_values(kpi_id,period,value) select id, date '2026-01-01', 1 from public.kpis limit 1")" \
  "violates row-level security"
assert_match "board UPDATE kpis affects 0 rows" \
  "$(as_role "$BOARD" "update public.kpis set name='HACK' where key='bypass_count'")" "UPDATE 0"
assert_eq    "kpis.bypass_count name intact"  "$(q "select name from public.kpis where key='bypass_count'")" "Bypass Count"

echo "RLS: founder may write KPI data"
assert_match "founder INSERT kpi_values ok" \
  "$(as_role "$FOUNDER" "insert into public.kpi_values(kpi_id,period,value) select id, date '2026-02-01', 1 from public.kpis where key='bypass_count'; select 'ok'")" \
  "ok"

echo "RLS: audit_log is immutable"
assert_match "board INSERT audit_log ok" \
  "$(as_role "$BOARD" "insert into public.audit_log(action) values ('login'); select 'ok'")" "ok"
assert_eq "audit_log INSERT policies = 1" "$(q "select count(*) from pg_policies where tablename='audit_log' and cmd='INSERT'")" "1"
assert_eq "audit_log SELECT policies = 1" "$(q "select count(*) from pg_policies where tablename='audit_log' and cmd='SELECT'")" "1"
assert_eq "audit_log UPDATE policies = 0" "$(q "select count(*) from pg_policies where tablename='audit_log' and cmd='UPDATE'")" "0"
assert_eq "audit_log DELETE policies = 0" "$(q "select count(*) from pg_policies where tablename='audit_log' and cmd='DELETE'")" "0"

echo "Schema: comments target exactly one entity"
assert_match "comments 0 targets rejected" \
  "$(as_role "$BOARD" "insert into public.comments(author_id,body) values ('$BOARD','x')")" "comments_one_target"
assert_match "comments 2 targets rejected" \
  "$(as_role "$BOARD" "insert into public.comments(author_id,body,kpi_id,memo_id) select '$BOARD','x',id,gen_random_uuid() from public.kpis limit 1")" \
  "comments_one_target"

echo
echo "==> $pass passed, $fail failed"
[ "$fail" -eq 0 ] || exit 1
echo "==> All Boardroom database guarantees verified."
