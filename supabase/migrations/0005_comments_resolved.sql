-- 0005_comments_resolved.sql
-- Resolve / unresolve support for threaded comments.
-- Body and polymorphic targets (kpi_id / memo_id / analysis_id) already exist
-- in 0001_schema.sql; this adds the durable resolved flag the board uses to
-- close a discussion without deleting history.

alter table public.comments
  add column if not exists resolved boolean not null default false;

comment on column public.comments.resolved is
  'True when the thread item is marked resolved; unresolve sets false. No delete.';

create index if not exists comments_resolved_idx on public.comments (resolved)
  where resolved = true;
