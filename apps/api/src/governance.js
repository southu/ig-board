// Governance data layer — roles, reaction catalog, soft-delete flags, and the
// public status snapshot used by GET /api/governance/status.
//
// Dual path:
//   * DATABASE_URL bound  → apply 0008_governance.sql on ensureReady(), then
//                           read counts / schema probes from Postgres.
//   * No DATABASE_URL     → in-process mirror (unit tests + un-provisioned
//                           deploys) with the same wire shape and invariants.
//
// Never mutates business data from the status reader. Soft-delete columns exist
// in schema/store but existing comment list APIs keep returning every row.

import { applyMigrations, isDatabaseConfigured, query } from './db.js';
import { commentCount } from './commentsStore.js';
import { SCORECARD_KPIS } from './scorecardData.js';
import { invitedEmailSet, userIdForEmail } from './selfAuth.js';

export const GOVERNANCE_ROLES = Object.freeze([
  'admin',
  'executive',
  'board_member',
  'employee',
  'consultant'
]);

export const REACTION_TYPES = Object.freeze(['like', 'dislike', 'question']);

export const OPERATOR_ADMIN_EMAIL = 'jason@readysignal.com';

// ---------------------------------------------------------------------------
// In-memory fallback (no DATABASE_URL)
// ---------------------------------------------------------------------------
let memory = freshMemory();
let memoryReady = false;

function freshMemory() {
  return {
    users: new Map(), // email -> { id, email, role, created_at }
    reactionUniqueConstraint: true,
    commentSoftDeleteFields: true,
    // Schema-level reaction registry (empty until a later UI wires writes).
    reactions: new Map()
  };
}

export function resetGovernanceMemory() {
  memory = freshMemory();
  memoryReady = false;
}

function seedMemoryUsers(env = process.env) {
  const now = new Date().toISOString();
  const emails = new Set(invitedEmailSet(env));
  emails.add(OPERATOR_ADMIN_EMAIL);

  // Materialize invite-list members (and the operator admin) as governance users.
  for (const email of emails) {
    const normalized = String(email).trim().toLowerCase();
    if (!normalized || memory.users.has(normalized)) continue;
    memory.users.set(normalized, {
      id: userIdForEmail(normalized),
      email: normalized,
      role: 'employee',
      created_at: now
    });
  }

  // Mission backfill: every user is employee, then promote operator admin
  // (or first-created owner if that email is absent from the table).
  for (const user of memory.users.values()) {
    user.role = 'employee';
  }

  const jason = memory.users.get(OPERATOR_ADMIN_EMAIL);
  if (jason) {
    jason.role = 'admin';
  } else {
    const ordered = [...memory.users.values()].sort((a, b) => {
      const c = String(a.created_at).localeCompare(String(b.created_at));
      return c !== 0 ? c : String(a.email).localeCompare(String(b.email));
    });
    if (ordered[0]) ordered[0].role = 'admin';
  }

  // Guarantee at least one user (operator admin).
  if (memory.users.size === 0) {
    memory.users.set(OPERATOR_ADMIN_EMAIL, {
      id: userIdForEmail(OPERATOR_ADMIN_EMAIL),
      email: OPERATOR_ADMIN_EMAIL,
      role: 'admin',
      created_at: now
    });
  }
}

function ensureMemoryReady(env = process.env) {
  if (memoryReady) return;
  seedMemoryUsers(env);
  memoryReady = true;
}

function memoryStatus() {
  ensureMemoryReady();
  const users = [...memory.users.values()];
  const admin = users.find((u) => u.role === 'admin');
  const withRole = users.filter((u) => GOVERNANCE_ROLES.includes(u.role));
  return {
    total_users: users.length,
    users_with_role: withRole.length,
    admin_count: users.filter((u) => u.role === 'admin').length,
    operator_admin_email: admin ? admin.email : null,
    roles: [...GOVERNANCE_ROLES],
    reaction_types: [...REACTION_TYPES],
    reaction_unique_constraint: Boolean(memory.reactionUniqueConstraint),
    comment_count: commentCount(),
    comment_soft_delete_fields: Boolean(memory.commentSoftDeleteFields),
    // Primary KPI/metric catalog — in-memory path has no kpis table rows, so
    // report the committed scorecard catalog size (stable, non-destructive).
    kpi_count: SCORECARD_KPIS.length,
    source: 'memory'
  };
}

// ---------------------------------------------------------------------------
// Postgres path
// ---------------------------------------------------------------------------
async function dbStatus() {
  await applyMigrations();

  const usersRes = await query(`
    select
      count(*)::int as total_users,
      count(*) filter (
        where role in ('admin','executive','board_member','employee','consultant')
      )::int as users_with_role,
      count(*) filter (where role = 'admin')::int as admin_count
    from public.users
  `);

  const adminRes = await query(`
    select email
    from public.users
    where role = 'admin'
    order by
      case when lower(email) = lower($1) then 0 else 1 end,
      created_at asc nulls last,
      id asc
    limit 1
  `, [OPERATOR_ADMIN_EMAIL]);

  const commentRes = await query(
    `select count(*)::int as comment_count from public.comments`
  );

  const softRes = await query(`
    select
      exists (
        select 1 from information_schema.columns
        where table_schema = 'public' and table_name = 'comments'
          and column_name = 'deleted_at'
      )
      and exists (
        select 1 from information_schema.columns
        where table_schema = 'public' and table_name = 'comments'
          and column_name = 'deleted_by'
      ) as comment_soft_delete_fields
  `);

  const uniqRes = await query(`
    select exists (
      select 1
      from pg_constraint c
      join pg_class t on c.conrelid = t.oid
      join pg_namespace n on t.relnamespace = n.oid
      where n.nspname = 'public'
        and t.relname = 'comment_reactions'
        and c.contype in ('u', 'p')
        and (
          pg_get_constraintdef(c.oid) ilike '%comment_id%user_id%'
          or pg_get_constraintdef(c.oid) ilike '%user_id%comment_id%'
          or c.conname ilike '%comment_user%'
        )
    )
    or exists (
      select 1
      from pg_indexes
      where schemaname = 'public'
        and tablename = 'comment_reactions'
        and indexdef ilike '%unique%'
        and indexdef ilike '%comment_id%'
        and indexdef ilike '%user_id%'
    ) as reaction_unique_constraint
  `);

  // Primary KPI/metric table row count. When the live path still serves the
  // committed catalog (empty kpis table), report catalog size so the status
  // surface matches the scorecard the board actually sees.
  const kpiRes = await query(`select count(*)::int as kpi_count from public.kpis`);
  const dbKpis = kpiRes.rows[0]?.kpi_count ?? 0;
  const kpiCount = dbKpis > 0 ? dbKpis : SCORECARD_KPIS.length;

  // comment_count: max of DB rows and in-process store so a self-hosted deploy
  // that keeps comments in memory still reports a truthful non-zero after use,
  // and never under-counts across process-local writes.
  const dbComments = commentRes.rows[0]?.comment_count ?? 0;
  const memComments = commentCount();
  const comment_count = Math.max(dbComments, memComments);

  const u = usersRes.rows[0] || {};
  return {
    total_users: u.total_users ?? 0,
    users_with_role: u.users_with_role ?? 0,
    admin_count: u.admin_count ?? 0,
    operator_admin_email: adminRes.rows[0]?.email ?? null,
    roles: [...GOVERNANCE_ROLES],
    reaction_types: [...REACTION_TYPES],
    reaction_unique_constraint: Boolean(uniqRes.rows[0]?.reaction_unique_constraint),
    comment_count,
    comment_soft_delete_fields: Boolean(softRes.rows[0]?.comment_soft_delete_fields),
    kpi_count: kpiCount,
    source: 'database'
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

// Ensure migrations (or memory seed) have run. Idempotent.
export async function ensureGovernanceReady(env = process.env) {
  if (isDatabaseConfigured(env)) {
    const result = await applyMigrations(env);
    if (!result.ok) {
      // Fall through to memory so /api/governance/status still answers and the
      // process does not crash the healthcheck on a transient DB blip.
      ensureMemoryReady(env);
      return { ok: false, fallback: 'memory', error: result.error };
    }
    return result;
  }
  ensureMemoryReady(env);
  return { ok: true, skipped: true, reason: 'no_database_url' };
}

// Read-only governance status snapshot. Never writes.
export async function governanceStatus(env = process.env) {
  if (isDatabaseConfigured(env)) {
    try {
      return await dbStatus();
    } catch (err) {
      console.error('[governance] db status failed, using memory:', err && err.message);
      return memoryStatus();
    }
  }
  return memoryStatus();
}
