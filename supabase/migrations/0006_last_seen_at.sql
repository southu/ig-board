-- 0006_last_seen_at.sql
-- Phase 4: users.last_seen_at drives the /whats-new digest cursor.
-- When bound to a real Supabase project, the API can persist the cursor here;
-- the un-provisioned live path uses the in-process whatsNewStore instead.

alter table public.users
  add column if not exists last_seen_at timestamptz;

comment on column public.users.last_seen_at is
  'Cursor for /whats-new: only changes strictly after this timestamp are listed.';
