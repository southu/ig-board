# Boardroom database

Postgres schema for Supabase with **deny-by-default Row Level Security (RLS)** on
every table.

## Migrations

Applied in filename order:

| File               | Purpose                                                  |
| ------------------ | -------------------------------------------------------- |
| `0001_schema.sql`  | All tables + indexes + constraints                       |
| `0002_roles.sql`   | `app` schema + `app.current_user_role()` role resolver   |
| `0003_rls.sql`     | Enable RLS + all policies (deny-by-default)              |

## Seed

`seed.sql` is the **single idempotent seed script**. Every row is keyed on a
stable natural key (`layers.position`, `kpis.key`) and upserted with
`ON CONFLICT ... DO UPDATE`, so running it any number of times converges to the
same rows:

- **5 ordered layers** — positions 1‑3 `manage=true`, positions 4‑5 `manage=false`
- **25 KPIs** with definition, owner, cadence, direction
  (`up_good` / `down_good` / `target_band`) and thresholds, including:
  - `bypass_count` — direction `down_good`, green=0 / yellow=1‑2 / red=3+;
    note *"the single most important number on this scorecard"*
  - `touches_per_order` — baseline 12‑15 (`target_min`/`target_max`), green ≤ 6
  - `revenue_plan_fy1|fy2|fy3` — $29M / $33M / $35M (placeholders, TBD)

```bash
export DATABASE_URL=postgres://...
./seed.sh          # applies migrations, then seeds (idempotent)
# or just the seed against an already-migrated db:
psql "$DATABASE_URL" -f seed.sql
```

### Idempotency evidence

Reproduce end to end against a throwaway database (`psql` required):

```bash
DATABASE_URL=postgres://postgres@127.0.0.1:5432/postgres ./verify.sh
```

`verify.sh` applies the migrations, seeds **twice**, and asserts identical final
row counts — then runs the RLS assertions below. It exits non-zero on the first
failed assertion. Latest run: **20 passed, 0 failed** on Postgres 16.

Two consecutive runs of `seed.sql` against a fresh Postgres 16 produced identical
final row counts:

```
=== SEED RUN 1 ===         === SEED RUN 2 ===
 table  | rows              table  | rows
--------+------            --------+------
 kpis   |   25              kpis   |   25
 layers |    5              layers |    5
```

## RLS model

RLS is **enabled on every table**. With RLS enabled and no matching policy,
access is denied — so the `anon` (unauthenticated) role, which is granted no
policy and no table privileges, is **denied on all tables**.

Roles come from `public.users.role` (`founder` | `board`), resolved for the
current request by `app.current_user_role()` (SECURITY DEFINER; returns `NULL`
for anon, so every role check fails closed).

| Table         | anon | board                                   | founder     |
| ------------- | ---- | --------------------------------------- | ----------- |
| users         | ✗    | read                                    | read/write  |
| layers        | ✗    | read                                    | read/write  |
| kpis          | ✗    | read (**no UPDATE**)                    | read/write  |
| kpi_values    | ✗    | read (**no INSERT**)                    | read/write  |
| memos         | ✗    | read only (no upload)                   | read/write (upload + extract) |
| analyses      | ✗    | read; author own                        | read/write  |
| comments      | ✗    | read; author own                        | read/write  |
| agendas       | ✗    | read                                    | read/write  |
| audit_log     | ✗    | **INSERT + SELECT only** (immutable)    | INSERT+SELECT |

Key guarantees (verified — see below):

- **anon is denied on every table.**
- **board cannot INSERT `kpi_values`** — RLS rejects the insert.
- **board cannot UPDATE `kpis`** — the update matches no row (0 rows affected).
- **`audit_log` has no UPDATE or DELETE policy** — the trail is immutable; only
  `INSERT` and `SELECT` policies exist.
- **`comments` targets exactly one** of `kpi_id` / `memo_id` / `analysis_id`
  (CHECK `num_nonnulls(...) = 1`), with self-referential `parent_id` threading.

### RLS verification evidence

Reproduced by `./verify.sh` (see above), which installs a Supabase-style
`auth.uid()` shim plus `anon` / `authenticated` roles and asserts each guarantee.
Sample run against a fresh Postgres 16:

```
anon    SELECT kpis                 -> ERROR: permission denied for table kpis   ✓ denied
anon    SELECT users                -> ERROR: permission denied for table users  ✓ denied
founder SELECT kpis                 -> 25                                          ✓
board   SELECT kpis                 -> 25   (role resolved = board)                ✓
board   INSERT kpi_values           -> ERROR: new row violates RLS policy          ✓ denied
board   UPDATE kpis                 -> UPDATE 0                                     ✓ denied
founder INSERT kpi_values           -> INSERT 0 1                                   ✓ allowed
board   INSERT audit_log            -> INSERT 0 1                                   ✓ allowed
board   UPDATE audit_log            -> UPDATE 0   (no policy)                       ✓ immutable
board   DELETE audit_log            -> DELETE 0   (no policy)                       ✓ immutable
comments INSERT (0 targets)         -> ERROR: violates comments_one_target          ✓
comments INSERT (2 targets)         -> ERROR: violates comments_one_target          ✓
comments INSERT (exactly 1 target)  -> INSERT 0 1                                    ✓
audit_log policies                  -> INSERT | 1, SELECT | 1   (no UPDATE/DELETE)   ✓
```

> The migrations assume the platform-provided `auth.uid()` on Supabase. For local
> testing only, define a shim before applying migrations:
>
> ```sql
> create schema if not exists auth;
> create or replace function auth.uid() returns uuid language sql stable as $$
>   select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
> ```
