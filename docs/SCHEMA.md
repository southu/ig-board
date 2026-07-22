# Boardroom schema

Full Supabase-compatible Postgres schema for the ig-board Boardroom BI platform.
The SQL runs unchanged on a plain PostgreSQL instance (Railway) or on Supabase —
a compatibility bootstrap creates the Supabase roles / `auth.*` helpers only when
they are missing.

## Layout

```
db/
  migrations/
    0000_supabase_compat.sql   roles (anon/authenticated/service_role), auth.uid/role/jwt, extensions
    0001_schema.sql            all tables + role-helper functions (app.is_founder / app.is_member)
    0002_rls.sql               RLS deny-by-default + role-aware policies
  seed/
    seed.sql                   ONE idempotent seed: 5 layers + ~25 KPIs
  cli.js                       migrate | seed | counts | probe (uses DATABASE_URL)
scripts/
  seed-twice.sh                runs the seed twice and asserts identical row counts
transcripts/
  seed-idempotency.txt         captured proof of idempotent seeding
  rls-probes.txt               captured proof of the RLS guarantees
server.js                      serves /version (git SHA); best-effort migrate+seed on boot
```

## Tables

| table        | purpose                                                            |
|--------------|--------------------------------------------------------------------|
| `users`      | Boardroom members. `role` is `founder` \| `board`.                 |
| `layers`     | 5 ordered scorecard tiers; `manage` = actively managed vs monitor. |
| `kpis`       | Metric definitions. `direction` = `up_good`\|`down_good`\|`target_band`. |
| `kpi_values` | Periodic measurements per KPI.                                     |
| `memos`      | Board memos / briefs.                                              |
| `analyses`   | Written analyses, optionally tied to a KPI.                        |
| `comments`   | Threaded (`parent_id`) discussion attached to EXACTLY ONE of a kpi/memo/analysis (CHECK). |
| `agendas`    | Board meeting agendas (`items` jsonb).                             |
| `audit_log`  | Append-only, immutable action trail.                              |

## RLS model (deny-by-default)

Every table has RLS enabled with no blanket policy, so absent a matching policy a
role sees nothing.

- **anon** — holds the table `SELECT` grant but matches no policy ⇒ **zero rows**.
- **authenticated** — gated by the app role resolved from `public.users` via
  `auth.uid()`:
  - **founder** — full read/write across the schema.
  - **board** — reads everything; may author its own memos / analyses / comments;
    **cannot** write `kpis` or `kpi_values`.
- **service_role** — `BYPASSRLS` for server-side work.

### audit_log immutability

`audit_log` has only `INSERT` and `SELECT` policies — there is deliberately no
`UPDATE` or `DELETE` policy. In addition, `UPDATE`/`DELETE` privileges are revoked
from every role and `FORCE ROW LEVEL SECURITY` is set, so no role (anon,
authenticated, board, founder, or service_role) can mutate history.

## Seed

`db/seed/seed.sql` is a single idempotent script (upsert on `layers.position` and
`kpis.key`). It creates exactly **5 layers** (positions 1-3 `manage=true`, 4-5
`manage=false`) and **25 KPIs**, including the mission-critical ones:

- **bypass_count** — definition *"the single most important number on this
  scorecard"*, `down_good`, thresholds green `0` / yellow `1-2` / red `3+`.
- **touches_per_order** — `down_good`, baseline `12-15`, green `<=6`.
- **revenue_plan** — `up_good`, three-year plan `$29M / $33M / $35M`.

KPIs whose targets are not yet set (`client_nps`, `csat`) are marked
`is_placeholder = true` with `TBD` thresholds.

## Running

```bash
export DATABASE_URL=postgres://…
npm install
npm run migrate     # apply migrations 0000→0002
npm run seed        # idempotent seed
npm run counts      # per-table row counts (JSON)
npm run probe       # RLS probes (anon / board / audit immutability)
npm run seed:twice  # seed idempotency proof
```

The deployed service also runs `migrate` + `seed` on boot when `DATABASE_URL` is
present; a missing/unreachable database never blocks `/version` from serving.
