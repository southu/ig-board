-- Final commit outcomes are append-only records linked to the immutable
-- preview attempt.  This keeps the original upload/preview unchanged while
-- making a commit retry safely return the already recorded outcome.
create table if not exists public.kpi_import_commit_results (
  attempt_id uuid primary key references public.kpi_import_attempts(id) on delete restrict,
  created_at timestamptz not null default now(),
  outcome text not null check (outcome in ('committed', 'rejected', 'stale')),
  counts jsonb not null check (jsonb_typeof(counts) = 'object'),
  errors jsonb not null default '[]'::jsonb check (jsonb_typeof(errors) = 'array')
);

create or replace function public.reject_kpi_import_commit_result_mutation()
returns trigger language plpgsql as $$
begin
  raise exception 'kpi import commit results are immutable' using errcode = '55000';
end;
$$;

drop trigger if exists kpi_import_commit_results_no_update on public.kpi_import_commit_results;
create trigger kpi_import_commit_results_no_update before update on public.kpi_import_commit_results
  for each row execute function public.reject_kpi_import_commit_result_mutation();
drop trigger if exists kpi_import_commit_results_no_delete on public.kpi_import_commit_results;
create trigger kpi_import_commit_results_no_delete before delete on public.kpi_import_commit_results
  for each row execute function public.reject_kpi_import_commit_result_mutation();
