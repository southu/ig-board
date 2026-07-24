-- Make the KPI author dependency durable on self-hosted/Railway databases.
-- Member deletion deliberately blocks while these rows exist; SET NULL is
-- retained only for compatibility with legacy direct SQL callers.
create table if not exists public.kpi_values (
  id uuid primary key default gen_random_uuid(),
  kpi_id uuid references public.kpis(id) on delete cascade,
  period date not null default current_date,
  value numeric,
  note text,
  recorded_by uuid references public.users(id) on delete set null,
  created_at timestamptz not null default now()
);

alter table public.kpi_values add column if not exists recorded_by uuid;
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'kpi_values_recorded_by_fkey'
      and conrelid = 'public.kpi_values'::regclass
  ) then
    alter table public.kpi_values
      add constraint kpi_values_recorded_by_fkey
      foreign key (recorded_by) references public.users(id) on delete set null;
  end if;
end $$;

create index if not exists kpi_values_recorded_by_idx
  on public.kpi_values (recorded_by);
