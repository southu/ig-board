-- 0001_schema.sql
-- Core Boardroom tables. The role helper is added in 0002_roles.sql and RLS is
-- enabled in 0003_rls.sql (deny-by-default).
--
-- All ids are uuid (gen_random_uuid(), built-in since PG13). public.users.id is
-- intended to equal the Supabase auth.users.id for the same person.

-- ---------------------------------------------------------------------------
-- users: board members and founders
-- ---------------------------------------------------------------------------
create table if not exists public.users (
  id         uuid primary key default gen_random_uuid(),
  email      text not null unique,
  full_name  text,
  role       text not null check (role in ('founder', 'board')),
  created_at timestamptz not null default now()
);

comment on table public.users is 'Boardroom principals; role gates all RLS.';

-- ---------------------------------------------------------------------------
-- layers: the ordered scorecard layers (1..5)
-- ---------------------------------------------------------------------------
create table if not exists public.layers (
  id          uuid primary key default gen_random_uuid(),
  position    int  not null unique check (position >= 1),
  name        text not null,
  description text,
  -- manage=true layers are the ones the board actively steers.
  manage      boolean not null default false,
  created_at  timestamptz not null default now()
);

comment on table public.layers is 'Ordered scorecard layers; positions 1-5.';

-- ---------------------------------------------------------------------------
-- kpis: KPI definitions
-- ---------------------------------------------------------------------------
create table if not exists public.kpis (
  id          uuid primary key default gen_random_uuid(),
  key         text not null unique,               -- stable natural key for idempotent seed
  name        text not null,
  definition  text,
  owner       text,
  cadence     text,                               -- e.g. weekly, monthly, quarterly, annual
  layer_id    uuid references public.layers(id) on delete set null,
  direction   text not null check (direction in ('up_good', 'down_good', 'target_band')),
  unit        text,
  green_threshold  numeric,
  yellow_threshold numeric,
  red_threshold    numeric,
  target_min  numeric,                            -- for target_band KPIs
  target_max  numeric,
  notes       text,
  created_at  timestamptz not null default now()
);

comment on table public.kpis is 'KPI catalog with thresholds and rag direction.';

-- ---------------------------------------------------------------------------
-- kpi_values: time-series observations for a KPI
-- ---------------------------------------------------------------------------
create table if not exists public.kpi_values (
  id          uuid primary key default gen_random_uuid(),
  kpi_id      uuid not null references public.kpis(id) on delete cascade,
  period      date not null,
  value       numeric,
  status      text check (status in ('green', 'yellow', 'red')),
  note        text,
  recorded_by uuid references public.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  unique (kpi_id, period)
);

comment on table public.kpi_values is 'Observed KPI values by period (founder-authored).';

-- ---------------------------------------------------------------------------
-- memos: written governance memos
-- ---------------------------------------------------------------------------
create table if not exists public.memos (
  id         uuid primary key default gen_random_uuid(),
  author_id  uuid references public.users(id) on delete set null,
  title      text not null,
  body       text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.memos is 'Governance memos authored by principals.';

-- ---------------------------------------------------------------------------
-- analyses: deeper written analyses
-- ---------------------------------------------------------------------------
create table if not exists public.analyses (
  id         uuid primary key default gen_random_uuid(),
  author_id  uuid references public.users(id) on delete set null,
  title      text not null,
  summary    text,
  body       text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.analyses is 'Longer-form analyses authored by principals.';

-- ---------------------------------------------------------------------------
-- comments: threaded discussion attached to exactly one parent entity
-- ---------------------------------------------------------------------------
create table if not exists public.comments (
  id          uuid primary key default gen_random_uuid(),
  author_id   uuid references public.users(id) on delete set null,
  parent_id   uuid references public.comments(id) on delete cascade,  -- threading
  kpi_id      uuid references public.kpis(id) on delete cascade,
  memo_id     uuid references public.memos(id) on delete cascade,
  analysis_id uuid references public.analyses(id) on delete cascade,
  body        text not null,
  created_at  timestamptz not null default now(),
  -- exactly one of kpi_id / memo_id / analysis_id must be set
  constraint comments_one_target check (
    num_nonnulls(kpi_id, memo_id, analysis_id) = 1
  )
);

comment on table public.comments is 'Threaded comments on a KPI, memo, or analysis (exactly one).';

-- ---------------------------------------------------------------------------
-- agendas: board meeting agendas
-- ---------------------------------------------------------------------------
create table if not exists public.agendas (
  id           uuid primary key default gen_random_uuid(),
  title        text not null,
  scheduled_for timestamptz,
  body         text,
  created_by   uuid references public.users(id) on delete set null,
  created_at   timestamptz not null default now()
);

comment on table public.agendas is 'Board meeting agendas (founder-managed).';

-- ---------------------------------------------------------------------------
-- audit_log: append-only audit trail (immutable — see RLS)
-- ---------------------------------------------------------------------------
create table if not exists public.audit_log (
  id         uuid primary key default gen_random_uuid(),
  actor_id   uuid references public.users(id) on delete set null,
  action     text not null,
  entity     text,
  entity_id  uuid,
  detail     jsonb,
  created_at timestamptz not null default now()
);

comment on table public.audit_log is 'Append-only audit trail; no UPDATE/DELETE policy (immutable).';

create index if not exists kpis_layer_id_idx      on public.kpis (layer_id);
create index if not exists kpi_values_kpi_id_idx  on public.kpi_values (kpi_id);
create index if not exists comments_parent_id_idx on public.comments (parent_id);
create index if not exists comments_kpi_id_idx     on public.comments (kpi_id);
create index if not exists comments_memo_id_idx     on public.comments (memo_id);
create index if not exists comments_analysis_id_idx on public.comments (analysis_id);
create index if not exists audit_log_created_at_idx on public.audit_log (created_at);
