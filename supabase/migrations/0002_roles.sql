-- 0002_roles.sql
-- Boardroom (ig-board) foundation: helper schema + role resolver used by RLS.
-- Depends on public.users from 0001_schema.sql.
--
-- Roles model:
--   * public.users.role is either 'founder' or 'board'.
--   * app.current_user_role() maps the authenticated JWT (auth.uid()) to that
--     role. It is SECURITY DEFINER so it can read public.users regardless of the
--     caller's own RLS, avoiding recursive policy evaluation.
--   * Anonymous / unauthenticated callers resolve to NULL, so every role check
--     of the form "role in ('founder','board')" fails closed for anon.
--
-- Safe to run against a fresh database. On Supabase, auth.uid() is provided by
-- the platform; a local shim is only needed for offline testing.

create schema if not exists app;

create or replace function app.current_user_role()
returns text
language sql
stable
security definer
set search_path = public, app
as $$
  select u.role
  from public.users u
  where u.id = auth.uid();
$$;

comment on function app.current_user_role() is
  'Resolves the app role (founder|board) for the current auth.uid(); NULL for anon.';

-- Callers execute the helper inside policy checks; grant to both API roles.
grant usage on schema app to anon, authenticated;
grant execute on function app.current_user_role() to anon, authenticated;
