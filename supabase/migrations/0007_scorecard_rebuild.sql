-- Rich board-spec fields and a distinct, time-boxed watch-item entity.
alter table public.kpis
  add column if not exists code text unique,
  add column if not exists type text not null default 'permanent_kpi',
  add column if not exists baseline text,
  add column if not exists baseline_source text,
  add column if not exists green_text text,
  add column if not exists yellow_text text,
  add column if not exists red_text text,
  add column if not exists definition_note text,
  add column if not exists manual_entry boolean not null default true,
  add column if not exists metadata jsonb not null default '{}'::jsonb;

alter table public.kpis drop constraint if exists kpis_type_check;
alter table public.kpis
  add constraint kpis_type_check
  check (type in ('permanent_kpi', 'computed'));

create table if not exists public.watch_items (
  id            uuid primary key default gen_random_uuid(),
  key           text not null unique,
  name          text not null,
  type          text not null check (type = 'special_watch_item'),
  layer_id      uuid not null references public.layers(id) on delete cascade,
  definition    text not null,
  green_text    text,
  yellow_text   text,
  red_text      text,
  review_text   text not null,
  review_at     text,
  disposition   text,
  created_at    timestamptz not null default now()
);

create index if not exists watch_items_layer_id_idx on public.watch_items(layer_id);

alter table public.watch_items enable row level security;

create policy watch_items_select on public.watch_items
  for select to authenticated using (public.current_app_role() in ('founder', 'board'));

create policy watch_items_founder_write on public.watch_items
  for all to authenticated
  using (public.current_app_role() = 'founder')
  with check (public.current_app_role() = 'founder');
