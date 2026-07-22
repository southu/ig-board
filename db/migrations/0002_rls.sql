-- 0002_rls.sql
-- Row Level Security: deny-by-default on every Boardroom table, with
-- role-aware policies. Idempotent (drop policy if exists + create).
--
-- Model
--   anon           -> holds table SELECT grant but matches NO policy => 0 rows.
--   authenticated  -> matched by policies below, further gated by app role.
--   founder        -> full read/write across the schema.
--   board          -> read everything; author own memos/analyses/comments;
--                     may NOT write kpis or kpi_values.
--   service_role   -> BYPASSRLS (server-side/back-office).
--
-- audit_log is append-only for everyone: only INSERT + SELECT policies exist,
-- and UPDATE/DELETE privileges are revoked from every non-superuser role.

-- ---------------------------------------------------------------------------
-- Baseline privileges. RLS is what actually filters rows; these GRANTs just
-- make the tables reachable. anon deliberately keeps SELECT so that an anon
-- query succeeds but returns zero rows (deny-by-default), rather than erroring.
-- ---------------------------------------------------------------------------
grant usage on schema public to anon, authenticated, service_role;

grant select on all tables in schema public to anon, authenticated;
grant insert, update, delete on all tables in schema public to authenticated;
grant all on all tables in schema public to service_role;

-- Enable RLS everywhere (deny-by-default until a policy grants access).
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
drop policy if exists users_select on public.users;
create policy users_select on public.users
  for select to authenticated
  using (app.is_member());

drop policy if exists users_write_founder on public.users;
create policy users_write_founder on public.users
  for all to authenticated
  using (app.is_founder())
  with check (app.is_founder());

-- ===========================================================================
-- layers  (read: members; write: founder only)
-- ===========================================================================
drop policy if exists layers_select on public.layers;
create policy layers_select on public.layers
  for select to authenticated
  using (app.is_member());

drop policy if exists layers_write_founder on public.layers;
create policy layers_write_founder on public.layers
  for all to authenticated
  using (app.is_founder())
  with check (app.is_founder());

-- ===========================================================================
-- kpis  (read: members; write: founder only -> board cannot UPDATE kpis)
-- ===========================================================================
drop policy if exists kpis_select on public.kpis;
create policy kpis_select on public.kpis
  for select to authenticated
  using (app.is_member());

drop policy if exists kpis_write_founder on public.kpis;
create policy kpis_write_founder on public.kpis
  for all to authenticated
  using (app.is_founder())
  with check (app.is_founder());

-- ===========================================================================
-- kpi_values  (read: members; write: founder only -> board cannot INSERT)
-- ===========================================================================
drop policy if exists kpi_values_select on public.kpi_values;
create policy kpi_values_select on public.kpi_values
  for select to authenticated
  using (app.is_member());

drop policy if exists kpi_values_write_founder on public.kpi_values;
create policy kpi_values_write_founder on public.kpi_values
  for all to authenticated
  using (app.is_founder())
  with check (app.is_founder());

-- ===========================================================================
-- memos  (read: members; authors write own; founder writes any)
-- ===========================================================================
drop policy if exists memos_select on public.memos;
create policy memos_select on public.memos
  for select to authenticated
  using (app.is_member());

drop policy if exists memos_insert on public.memos;
create policy memos_insert on public.memos
  for insert to authenticated
  with check (app.is_member() and (author_id = auth.uid() or app.is_founder()));

drop policy if exists memos_update on public.memos;
create policy memos_update on public.memos
  for update to authenticated
  using (author_id = auth.uid() or app.is_founder())
  with check (author_id = auth.uid() or app.is_founder());

drop policy if exists memos_delete on public.memos;
create policy memos_delete on public.memos
  for delete to authenticated
  using (author_id = auth.uid() or app.is_founder());

-- ===========================================================================
-- analyses  (same pattern as memos)
-- ===========================================================================
drop policy if exists analyses_select on public.analyses;
create policy analyses_select on public.analyses
  for select to authenticated
  using (app.is_member());

drop policy if exists analyses_insert on public.analyses;
create policy analyses_insert on public.analyses
  for insert to authenticated
  with check (app.is_member() and (author_id = auth.uid() or app.is_founder()));

drop policy if exists analyses_update on public.analyses;
create policy analyses_update on public.analyses
  for update to authenticated
  using (author_id = auth.uid() or app.is_founder())
  with check (author_id = auth.uid() or app.is_founder());

drop policy if exists analyses_delete on public.analyses;
create policy analyses_delete on public.analyses
  for delete to authenticated
  using (author_id = auth.uid() or app.is_founder());

-- ===========================================================================
-- comments  (read: members; author own; founder any)
-- ===========================================================================
drop policy if exists comments_select on public.comments;
create policy comments_select on public.comments
  for select to authenticated
  using (app.is_member());

drop policy if exists comments_insert on public.comments;
create policy comments_insert on public.comments
  for insert to authenticated
  with check (app.is_member() and (author_id = auth.uid() or app.is_founder()));

drop policy if exists comments_update on public.comments;
create policy comments_update on public.comments
  for update to authenticated
  using (author_id = auth.uid() or app.is_founder())
  with check (author_id = auth.uid() or app.is_founder());

drop policy if exists comments_delete on public.comments;
create policy comments_delete on public.comments
  for delete to authenticated
  using (author_id = auth.uid() or app.is_founder());

-- ===========================================================================
-- agendas  (read: members; write: founder only)
-- ===========================================================================
drop policy if exists agendas_select on public.agendas;
create policy agendas_select on public.agendas
  for select to authenticated
  using (app.is_member());

drop policy if exists agendas_write_founder on public.agendas;
create policy agendas_write_founder on public.agendas
  for all to authenticated
  using (app.is_founder())
  with check (app.is_founder());

-- ===========================================================================
-- audit_log  (append-only / immutable)
--   * INSERT policy: any active member may append their own action.
--   * SELECT policy: founders may read the trail.
--   * NO update / delete policies exist.
--   * UPDATE/DELETE privileges revoked from every role; FORCE RLS so even the
--     table owner is subject to the (absent) update/delete policies.
-- ===========================================================================
drop policy if exists audit_log_insert on public.audit_log;
create policy audit_log_insert on public.audit_log
  for insert to authenticated
  with check (app.is_member());

drop policy if exists audit_log_select on public.audit_log;
create policy audit_log_select on public.audit_log
  for select to authenticated
  using (app.is_founder());

-- Lock the table down at the privilege level too.
revoke all on public.audit_log from public, anon, authenticated, service_role;
grant select, insert on public.audit_log to authenticated, service_role;
alter table public.audit_log force row level security;
