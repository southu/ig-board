-- 0003_rls.sql
-- Deny-by-default Row Level Security for every Boardroom table.
--
-- Model
-- =====
--   * RLS is ENABLED on every table. With RLS on and no matching policy, access
--     is denied — so the anon (unauthenticated) role, which is never granted a
--     policy, is denied on all tables.
--   * founder: full read/write on everything.
--   * board:   read everything; may author its own memos, analyses and comments;
--              may NOT write KPI data. In particular board cannot INSERT
--              kpi_values and cannot UPDATE kpis (no such policy exists for it).
--   * audit_log: INSERT + SELECT only. There is deliberately no UPDATE or DELETE
--     policy, so the trail is immutable for every non-owner role.
--
-- Policies are scoped `TO authenticated`; combined with the role helper this
-- fails closed for anon. Table owners (the migration/seed/service role) bypass
-- RLS, which is how the seed script writes rows.

-- Privileges: authenticated may attempt DML (RLS then gates rows); anon may not.
grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;
-- anon is intentionally granted nothing on these tables.

-- Enable RLS everywhere.
alter table public.users      enable row level security;
alter table public.layers     enable row level security;
alter table public.kpis       enable row level security;
alter table public.kpi_values enable row level security;
alter table public.memos      enable row level security;
alter table public.analyses   enable row level security;
alter table public.comments   enable row level security;
alter table public.agendas    enable row level security;
alter table public.audit_log  enable row level security;

-- ===========================================================================
-- users
-- ===========================================================================
create policy users_select on public.users
  for select to authenticated
  using (app.current_user_role() in ('founder', 'board'));

create policy users_founder_write on public.users
  for all to authenticated
  using (app.current_user_role() = 'founder')
  with check (app.current_user_role() = 'founder');

-- ===========================================================================
-- layers  (read: both; write: founder only)
-- ===========================================================================
create policy layers_select on public.layers
  for select to authenticated
  using (app.current_user_role() in ('founder', 'board'));

create policy layers_founder_write on public.layers
  for all to authenticated
  using (app.current_user_role() = 'founder')
  with check (app.current_user_role() = 'founder');

-- ===========================================================================
-- kpis  (read: both; write: founder only -> board CANNOT UPDATE kpis)
-- ===========================================================================
create policy kpis_select on public.kpis
  for select to authenticated
  using (app.current_user_role() in ('founder', 'board'));

create policy kpis_founder_write on public.kpis
  for all to authenticated
  using (app.current_user_role() = 'founder')
  with check (app.current_user_role() = 'founder');

-- ===========================================================================
-- kpi_values  (read: both; write: founder only -> board CANNOT INSERT values)
-- ===========================================================================
create policy kpi_values_select on public.kpi_values
  for select to authenticated
  using (app.current_user_role() in ('founder', 'board'));

create policy kpi_values_founder_write on public.kpi_values
  for all to authenticated
  using (app.current_user_role() = 'founder')
  with check (app.current_user_role() = 'founder');

-- ===========================================================================
-- memos  (read: both; founder full; board may author + edit own)
-- ===========================================================================
create policy memos_select on public.memos
  for select to authenticated
  using (app.current_user_role() in ('founder', 'board'));

create policy memos_founder_write on public.memos
  for all to authenticated
  using (app.current_user_role() = 'founder')
  with check (app.current_user_role() = 'founder');

create policy memos_author_insert on public.memos
  for insert to authenticated
  with check (
    app.current_user_role() in ('founder', 'board')
    and author_id = auth.uid()
  );

create policy memos_author_update on public.memos
  for update to authenticated
  using (author_id = auth.uid())
  with check (author_id = auth.uid());

create policy memos_author_delete on public.memos
  for delete to authenticated
  using (author_id = auth.uid());

-- ===========================================================================
-- analyses  (same shape as memos)
-- ===========================================================================
create policy analyses_select on public.analyses
  for select to authenticated
  using (app.current_user_role() in ('founder', 'board'));

create policy analyses_founder_write on public.analyses
  for all to authenticated
  using (app.current_user_role() = 'founder')
  with check (app.current_user_role() = 'founder');

create policy analyses_author_insert on public.analyses
  for insert to authenticated
  with check (
    app.current_user_role() in ('founder', 'board')
    and author_id = auth.uid()
  );

create policy analyses_author_update on public.analyses
  for update to authenticated
  using (author_id = auth.uid())
  with check (author_id = auth.uid());

create policy analyses_author_delete on public.analyses
  for delete to authenticated
  using (author_id = auth.uid());

-- ===========================================================================
-- comments  (read: both; either role may author + edit own)
-- ===========================================================================
create policy comments_select on public.comments
  for select to authenticated
  using (app.current_user_role() in ('founder', 'board'));

create policy comments_author_insert on public.comments
  for insert to authenticated
  with check (
    app.current_user_role() in ('founder', 'board')
    and author_id = auth.uid()
  );

create policy comments_author_update on public.comments
  for update to authenticated
  using (author_id = auth.uid())
  with check (author_id = auth.uid());

create policy comments_author_delete on public.comments
  for delete to authenticated
  using (
    author_id = auth.uid()
    or app.current_user_role() = 'founder'
  );

-- ===========================================================================
-- agendas  (read: both; write: founder only)
-- ===========================================================================
create policy agendas_select on public.agendas
  for select to authenticated
  using (app.current_user_role() in ('founder', 'board'));

create policy agendas_founder_write on public.agendas
  for all to authenticated
  using (app.current_user_role() = 'founder')
  with check (app.current_user_role() = 'founder');

-- ===========================================================================
-- audit_log  (INSERT + SELECT only -> immutable; NO update/delete policy)
-- ===========================================================================
create policy audit_log_insert on public.audit_log
  for insert to authenticated
  with check (app.current_user_role() in ('founder', 'board'));

create policy audit_log_select on public.audit_log
  for select to authenticated
  using (app.current_user_role() in ('founder', 'board'));

-- No UPDATE and no DELETE policy on public.audit_log — the append-only trail is
-- immutable for authenticated/anon roles.
