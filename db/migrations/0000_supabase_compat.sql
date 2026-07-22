-- 0000_supabase_compat.sql
-- Supabase compatibility bootstrap.
--
-- On a real Supabase database these objects already exist; every statement here
-- is idempotent and non-destructive, so the same migration set is safe to run
-- against either a plain PostgreSQL instance (e.g. Railway Postgres) or a
-- Supabase project. Nothing here is dropped or replaced if it already exists.

-- gen_random_uuid(), digest(), etc.
create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Roles used by Supabase / PostgREST.
--
-- These are NOLOGIN group roles. PostgREST connects as the `authenticator`
-- login role and SET ROLEs into `anon` / `authenticated` / `service_role`
-- per request based on the verified JWT. `service_role` bypasses RLS.
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- auth schema + JWT helpers (mirror of Supabase's auth.uid()/role()/jwt()).
--
-- Created only when missing so we never clobber Supabase's own definitions.
-- They read the request JWT claims that PostgREST injects into the
-- `request.jwt.claims` GUC. Outside a request (no GUC) they return NULL/anon.
-- ---------------------------------------------------------------------------
create schema if not exists auth;

do $$
begin
  if not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'auth' and p.proname = 'jwt'
  ) then
    execute $fn$
      create function auth.jwt() returns jsonb
        language sql stable
      as $body$
        select coalesce(
          nullif(current_setting('request.jwt.claims', true), '')::jsonb,
          '{}'::jsonb
        )
      $body$;
    $fn$;
  end if;

  if not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'auth' and p.proname = 'uid'
  ) then
    execute $fn$
      create function auth.uid() returns uuid
        language sql stable
      as $body$
        select nullif(auth.jwt() ->> 'sub', '')::uuid
      $body$;
    $fn$;
  end if;

  if not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'auth' and p.proname = 'role'
  ) then
    execute $fn$
      create function auth.role() returns text
        language sql stable
      as $body$
        select coalesce(
          nullif(auth.jwt() ->> 'role', ''),
          nullif(current_setting('request.jwt.claim.role', true), ''),
          'anon'
        )
      $body$;
    $fn$;
  end if;
end
$$;

-- Application helper schema (Boardroom role logic lives here).
create schema if not exists app;

grant usage on schema auth to anon, authenticated, service_role;
grant usage on schema app  to anon, authenticated, service_role;
