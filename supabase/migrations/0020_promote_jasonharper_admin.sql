-- 0020_promote_jasonharper_admin.sql
-- Promote the second operator admin, jason@jasonharper.com, to role 'admin'.
--
-- Reviewable, idempotent equivalent of the 0008 operator-admin promotion, but
-- for a DIFFERENT account: jason@jasonharper.com is NOT jason@readysignal.com
-- (0008 / OPERATOR_ADMIN_EMAIL). This migration touches ONLY jasonharper.com and
-- leaves every other user's role — including jason@readysignal.com and the
-- ratchet test accounts — untouched. Safe to re-run on every deploy/boot.

-- Ensure the users table + uuid generator exist even if this runs before the
-- schema migrations on a freshly provisioned database (mirrors 0008's guard).
create extension if not exists pgcrypto;

create table if not exists public.users (
  id         uuid primary key default gen_random_uuid(),
  email      text not null unique,
  full_name  text,
  role       text not null default 'employee',
  created_at timestamptz not null default now()
);

-- Insert the account if absent (case-insensitive), as admin. If a row already
-- exists for this email in any case, the WHERE guard makes this a no-op so we
-- never create a duplicate.
insert into public.users (email, full_name, role)
select 'jason@jasonharper.com', 'Jason Harper', 'admin'
where not exists (
  select 1 from public.users where lower(email) = lower('jason@jasonharper.com')
);

-- Promote the existing/just-inserted row to admin. Scoped to this one email.
update public.users
set role = 'admin'
where lower(email) = lower('jason@jasonharper.com')
  and role is distinct from 'admin';

-- Backfill a display name only when missing (never overwrite an existing one).
update public.users
set full_name = 'Jason Harper'
where lower(email) = lower('jason@jasonharper.com')
  and (full_name is null or btrim(full_name) = '');
