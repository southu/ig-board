-- 0001_schema.sql
-- Boardroom core schema for The Image Group BI platform.
--
-- Idempotent: every object uses CREATE ... IF NOT EXISTS / CREATE OR REPLACE so
-- the migration runner can safely apply it on every boot.

-- Keep updated_at columns fresh.
create or replace function app.touch_updated_at() returns trigger
  language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- users — Boardroom members. role is founder | board.
-- id aligns with the auth JWT `sub` (auth.uid()).
-- ---------------------------------------------------------------------------
create table if not exists public.users (
  id         uuid primary key default gen_random_uuid(),
  email      text not null unique,
  full_name  text,
  role       text not null check (role in ('founder', 'board')),
  is_active  boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists users_touch on public.users;
create trigger users_touch before update on public.users
  for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- layers — ordered scorecard tiers (top-down). manage flags a tier the board
-- actively manages vs. one it only monitors.
-- ---------------------------------------------------------------------------
create table if not exists public.layers (
  id          uuid primary key default gen_random_uuid(),
  position    integer not null unique check (position >= 1),
  name        text not null,
  slug        text not null unique,
  manage      boolean not null default false,
  description text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

drop trigger if exists layers_touch on public.layers;
create trigger layers_touch before update on public.layers
  for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- kpis — metric definitions. direction is up_good | down_good | target_band.
-- thresholds holds the green/yellow/red bands as jsonb (values may be numbers
-- or human ranges such as "1-2" / "3+" / "<=6").
-- ---------------------------------------------------------------------------
create table if not exists public.kpis (
  id             uuid primary key default gen_random_uuid(),
  layer_id       uuid references public.layers(id) on delete set null,
  key            text not null unique,
  name           text not null,
  definition     text,
  owner          text,
  cadence        text check (cadence in
                    ('daily','weekly','monthly','quarterly','annual','ad_hoc')),
  direction      text not null check (direction in
                    ('up_good','down_good','target_band')),
  unit           text,
  baseline       text,
  thresholds     jsonb not null default '{}'::jsonb,
  is_placeholder boolean not null default false,
  sort_order     integer,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

drop trigger if exists kpis_touch on public.kpis;
create trigger kpis_touch before update on public.kpis
  for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- kpi_values — periodic measurements for a kpi.
-- ---------------------------------------------------------------------------
create table if not exists public.kpi_values (
  id           uuid primary key default gen_random_uuid(),
  kpi_id       uuid not null references public.kpis(id) on delete cascade,
  period_start date not null,
  period_end   date,
  value        numeric,
  status       text check (status in ('green','yellow','red')),
  note         text,
  recorded_by  uuid references public.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  unique (kpi_id, period_start)
);

-- ---------------------------------------------------------------------------
-- memos — board memos / briefs.
-- ---------------------------------------------------------------------------
create table if not exists public.memos (
  id         uuid primary key default gen_random_uuid(),
  title      text not null,
  body       text,
  author_id  uuid references public.users(id) on delete set null,
  status     text not null default 'draft'
               check (status in ('draft','published','archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists memos_touch on public.memos;
create trigger memos_touch before update on public.memos
  for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- analyses — deeper written analyses, optionally tied to a kpi.
-- ---------------------------------------------------------------------------
create table if not exists public.analyses (
  id         uuid primary key default gen_random_uuid(),
  title      text not null,
  summary    text,
  body       text,
  kpi_id     uuid references public.kpis(id) on delete set null,
  author_id  uuid references public.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists analyses_touch on public.analyses;
create trigger analyses_touch before update on public.analyses
  for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- comments — threaded (parent_id) discussion attached to EXACTLY ONE of a
-- kpi / memo / analysis (enforced by CHECK).
-- ---------------------------------------------------------------------------
create table if not exists public.comments (
  id          uuid primary key default gen_random_uuid(),
  parent_id   uuid references public.comments(id) on delete cascade,
  author_id   uuid references public.users(id) on delete set null,
  body        text not null,
  kpi_id      uuid references public.kpis(id) on delete cascade,
  memo_id     uuid references public.memos(id) on delete cascade,
  analysis_id uuid references public.analyses(id) on delete cascade,
  created_at  timestamptz not null default now(),
  constraint comments_exactly_one_target check (
    ( (kpi_id      is not null)::int
    + (memo_id     is not null)::int
    + (analysis_id is not null)::int ) = 1
  )
);

create index if not exists comments_parent_idx   on public.comments(parent_id);
create index if not exists comments_kpi_idx       on public.comments(kpi_id);
create index if not exists comments_memo_idx      on public.comments(memo_id);
create index if not exists comments_analysis_idx  on public.comments(analysis_id);

-- ---------------------------------------------------------------------------
-- agendas — board meeting agendas. items is an ordered jsonb list.
-- ---------------------------------------------------------------------------
create table if not exists public.agendas (
  id           uuid primary key default gen_random_uuid(),
  title        text not null,
  meeting_date date,
  layer_id     uuid references public.layers(id) on delete set null,
  items        jsonb not null default '[]'::jsonb,
  status       text not null default 'draft'
                 check (status in ('draft','published','archived')),
  created_by   uuid references public.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

drop trigger if exists agendas_touch on public.agendas;
create trigger agendas_touch before update on public.agendas
  for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- audit_log — append-only. No updated_at, no triggers that mutate rows.
-- Immutability is enforced in 0002_rls.sql (no UPDATE/DELETE policies +
-- revoked UPDATE/DELETE privileges + FORCE ROW LEVEL SECURITY).
-- actor_id is intentionally NOT a FK so deleting a user never rewrites history.
-- ---------------------------------------------------------------------------
create table if not exists public.audit_log (
  id          uuid primary key default gen_random_uuid(),
  actor_id    uuid,
  actor_role  text,
  action      text not null,
  entity_type text not null,
  entity_id   uuid,
  details     jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

create index if not exists audit_log_entity_idx on public.audit_log(entity_type, entity_id);
create index if not exists audit_log_created_idx on public.audit_log(created_at);

-- ---------------------------------------------------------------------------
-- Role helpers. SECURITY DEFINER so policies can read public.users without
-- recursing into that table's own RLS. Owned by the migration role, which is
-- the table owner, so the read bypasses users' RLS safely.
-- ---------------------------------------------------------------------------
create or replace function app.user_role() returns text
  language sql stable security definer set search_path = public, pg_temp
as $$
  select u.role
  from public.users u
  where u.id = auth.uid() and u.is_active
$$;

create or replace function app.is_founder() returns boolean
  language sql stable security definer set search_path = public, pg_temp
as $$
  select coalesce(app.user_role() = 'founder', false)
$$;

-- Any active Boardroom member (founder or board).
create or replace function app.is_member() returns boolean
  language sql stable security definer set search_path = public, pg_temp
as $$
  select app.user_role() in ('founder', 'board')
$$;

revoke all on function app.user_role(), app.is_founder(), app.is_member() from public;
grant execute on function app.user_role(), app.is_founder(), app.is_member()
  to anon, authenticated, service_role;
