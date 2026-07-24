-- 0008_governance.sql
-- Governance data layer: expanded user roles, comment reactions, comment soft
-- delete, and idempotent role backfill. Safe to re-run on every deploy/boot.
--
-- Does NOT rewrite KPI/comment history. Additive schema + role backfill only.
-- Existing read paths continue to return all comments (soft-delete is schema
-- only until a later mission wires filter behavior).

-- ---------------------------------------------------------------------------
-- Ensure core tables exist (no-op when 0001 already applied)
-- ---------------------------------------------------------------------------
create table if not exists public.users (
  id         uuid primary key default gen_random_uuid(),
  email      text not null unique,
  full_name  text,
  role       text not null default 'employee',
  created_at timestamptz not null default now()
);

create table if not exists public.kpis (
  id          uuid primary key default gen_random_uuid(),
  key         text not null unique,
  name        text not null,
  definition  text,
  owner       text,
  cadence     text,
  layer_id    uuid,
  direction   text,
  unit        text,
  green_threshold  numeric,
  yellow_threshold numeric,
  red_threshold    numeric,
  target_min  numeric,
  target_max  numeric,
  notes       text,
  created_at  timestamptz not null default now()
);

create table if not exists public.comments (
  id          uuid primary key default gen_random_uuid(),
  author_id   uuid references public.users(id) on delete set null,
  parent_id   uuid references public.comments(id) on delete cascade,
  kpi_id      uuid,
  memo_id     uuid,
  analysis_id uuid,
  body        text not null,
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 1) User roles: exactly five governance values
-- ---------------------------------------------------------------------------
-- Drop any CHECK constraints on users.role (legacy founder|board or prior).
do $$
declare
  r record;
begin
  for r in
    select c.conname
    from pg_constraint c
    join pg_class t on c.conrelid = t.oid
    join pg_namespace n on t.relnamespace = n.oid
    where n.nspname = 'public'
      and t.relname = 'users'
      and c.contype = 'c'
      and pg_get_constraintdef(c.oid) ilike '%role%'
  loop
    execute format('alter table public.users drop constraint if exists %I', r.conname);
  end loop;
end $$;

-- Default for new rows.
alter table public.users
  alter column role set default 'employee';

-- Any missing / legacy / invalid role becomes employee (idempotent).
update public.users
set role = 'employee'
where role is null
   or role not in ('admin', 'executive', 'board_member', 'employee', 'consultant');

-- Promote the operator admin when present.
update public.users
set role = 'admin'
where lower(email) = lower('jason@readysignal.com');

-- If that email is absent, promote the oldest existing account (owner / first-created).
update public.users
set role = 'admin'
where id = (
  select u.id
  from public.users u
  order by u.created_at asc nulls last, u.id asc
  limit 1
)
and not exists (
  select 1 from public.users where role = 'admin'
);

-- Seed the operator admin when the table is empty so total_users > 0 after deploy.
insert into public.users (email, full_name, role)
select 'jason@readysignal.com', 'Operator Admin', 'admin'
where not exists (select 1 from public.users);

-- Re-apply the five-value check (drop first so re-runs stay idempotent).
alter table public.users drop constraint if exists users_role_check;
alter table public.users
  add constraint users_role_check
  check (role in ('admin', 'executive', 'board_member', 'employee', 'consultant'));

comment on column public.users.role is
  'Governance role: admin | executive | board_member | employee | consultant.';

-- Map governance roles onto the legacy founder|board RLS helper so existing
-- policies keep working without a full RLS rewrite. Stored roles remain the
-- five governance values; only the resolver used by policies is mapped.
-- Skipped on plain Postgres that has no auth.uid() (self-hosted Railway path).
create schema if not exists app;

do $$
begin
  if to_regprocedure('auth.uid()') is null then
    return;
  end if;
  execute $fn$
    create or replace function app.current_user_role()
    returns text
    language sql
    stable
    security definer
    set search_path = public, app
    as $body$
      select case u.role
        when 'admin' then 'founder'
        when 'executive' then 'board'
        when 'board_member' then 'board'
        when 'employee' then 'board'
        when 'consultant' then 'board'
        when 'founder' then 'founder'
        when 'board' then 'board'
        else u.role
      end
      from public.users u
      where u.id = auth.uid();
    $body$
  $fn$;
exception
  when others then
    raise notice 'app.current_user_role() refresh skipped: %', SQLERRM;
end $$;

-- ---------------------------------------------------------------------------
-- 2) Comment reactions (one reaction per user per comment)
-- ---------------------------------------------------------------------------
create table if not exists public.comment_reactions (
  id            uuid primary key default gen_random_uuid(),
  comment_id    uuid not null references public.comments(id) on delete cascade,
  user_id       uuid not null references public.users(id) on delete cascade,
  reaction_type text not null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint comment_reactions_type_check
    check (reaction_type in ('like', 'dislike', 'question')),
  constraint comment_reactions_comment_user_unique unique (comment_id, user_id)
);

-- In case the table pre-existed without the uniqueness constraint, ensure it.
do $$
begin
  if not exists (
    select 1
    from pg_constraint c
    join pg_class t on c.conrelid = t.oid
    join pg_namespace n on t.relnamespace = n.oid
    where n.nspname = 'public'
      and t.relname = 'comment_reactions'
      and c.conname = 'comment_reactions_comment_user_unique'
  ) then
    alter table public.comment_reactions
      add constraint comment_reactions_comment_user_unique unique (comment_id, user_id);
  end if;
exception
  when duplicate_table then null;
  when duplicate_object then null;
end $$;

do $$
begin
  if not exists (
    select 1
    from pg_constraint c
    join pg_class t on c.conrelid = t.oid
    join pg_namespace n on t.relnamespace = n.oid
    where n.nspname = 'public'
      and t.relname = 'comment_reactions'
      and c.conname = 'comment_reactions_type_check'
  ) then
    alter table public.comment_reactions
      add constraint comment_reactions_type_check
      check (reaction_type in ('like', 'dislike', 'question'));
  end if;
exception
  when duplicate_object then null;
end $$;

create index if not exists comment_reactions_comment_id_idx
  on public.comment_reactions (comment_id);
create index if not exists comment_reactions_user_id_idx
  on public.comment_reactions (user_id);

comment on table public.comment_reactions is
  'One reaction (like|dislike|question) per user per comment.';

-- Optional RLS (skipped when the authenticated role is absent, e.g. plain PG).
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    return;
  end if;
  if to_regprocedure('auth.uid()') is null then
    return;
  end if;
  alter table public.comment_reactions enable row level security;
  drop policy if exists comment_reactions_select on public.comment_reactions;
  create policy comment_reactions_select on public.comment_reactions
    for select to authenticated
    using (app.current_user_role() in ('founder', 'board'));
  drop policy if exists comment_reactions_write on public.comment_reactions;
  create policy comment_reactions_write on public.comment_reactions
    for all to authenticated
    using (app.current_user_role() in ('founder', 'board'))
    with check (
      app.current_user_role() in ('founder', 'board')
      and user_id = auth.uid()
    );
exception
  when others then
    raise notice 'comment_reactions RLS skipped: %', SQLERRM;
end $$;

-- ---------------------------------------------------------------------------
-- 3) Comment soft delete (schema only — read paths unchanged)
-- ---------------------------------------------------------------------------
alter table public.comments
  add column if not exists deleted_at timestamptz;

alter table public.comments
  add column if not exists deleted_by uuid references public.users(id) on delete set null;

comment on column public.comments.deleted_at is
  'Soft-delete timestamp; NULL means the comment is active. Existing list APIs still return all rows.';
comment on column public.comments.deleted_by is
  'User who soft-deleted the comment; NULL when not deleted.';

create index if not exists comments_deleted_at_idx
  on public.comments (deleted_at)
  where deleted_at is not null;
