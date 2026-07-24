// Admin user directory — list / create / edit users and resolve live roles.
//
// Dual path (same pattern as governance.js):
//   * DATABASE_URL bound → public.users via Postgres
//   * No DATABASE_URL    → in-process Map (unit tests + current production path)
//
// Role changes are written here and re-read on every authenticated request so
// capability checks take effect on the affected user's next request without
// redeploy or session re-mint.

import { applyMigrations, isDatabaseConfigured, query } from './db.js';
import { GOVERNANCE_ROLES } from './permissions.js';
import {
  inviteEmail,
  setRoleForEmail,
  userIdForEmail,
  invitedEmailSet
} from './selfAuth.js';

export const RATCHET_ADMIN_EMAIL = 'ratchet-admin@boardroom.test';
export const RATCHET_EMPLOYEE_EMAIL = 'ratchet-employee@boardroom.test';

const ROLE_SET = new Set(GOVERNANCE_ROLES);

// ---------------------------------------------------------------------------
// In-memory fallback
// ---------------------------------------------------------------------------
/** @type {Map<string, object>} id -> user */
let byId = new Map();
/** @type {Map<string, string>} email -> id */
let emailIndex = new Map();
let memoryReady = false;

function normalizeEmail(email) {
  return String(email || '')
    .trim()
    .toLowerCase();
}

function nowIso() {
  return new Date().toISOString();
}

function publicUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    full_name: row.full_name ?? null,
    role: row.role,
    created_at: row.created_at,
    updated_at: row.updated_at ?? row.created_at
  };
}

function seedStaticUsers(env = process.env) {
  const now = nowIso();
  const defaults = [
    {
      email: RATCHET_ADMIN_EMAIL,
      full_name: 'Ratchet Admin',
      role: 'admin'
    },
    {
      email: RATCHET_EMPLOYEE_EMAIL,
      full_name: 'Ratchet Employee',
      role: 'employee'
    },
    {
      email: 'admin.e2e@boardroom.test',
      full_name: 'Admin E2E',
      role: 'admin'
    },
    {
      email: 'board_member.e2e@boardroom.test',
      full_name: 'Board Member E2E',
      role: 'board_member'
    },
    {
      email: 'founder.e2e@boardroom.test',
      full_name: 'Founder E2E',
      role: 'admin'
    },
    {
      email: 'board.e2e@boardroom.test',
      full_name: 'Board E2E',
      role: 'board_member'
    },
    {
      email: 'jason@readysignal.com',
      full_name: 'Operator Admin',
      role: 'admin'
    }
  ];

  // Env-overridden test emails (production may bind real inboxes).
  const envAdmin =
    (env.ADMIN_TEST_EMAIL || env.FOUNDER_TEST_EMAIL || '').trim().toLowerCase();
  const envBoard = (
    env.BOARD_MEMBER_TEST_EMAIL ||
    env.BOARD_TEST_EMAIL ||
    ''
  )
    .trim()
    .toLowerCase();
  if (envAdmin) {
    defaults.push({
      email: envAdmin,
      full_name: 'Admin Test',
      role: 'admin'
    });
  }
  if (envBoard) {
    defaults.push({
      email: envBoard,
      full_name: 'Board Member Test',
      role: 'board_member'
    });
  }

  // All invite-list members land as employees unless a more specific default
  // above already assigned a role (first write wins for a given email).
  for (const email of invitedEmailSet(env)) {
    defaults.push({
      email,
      full_name: null,
      role: 'employee'
    });
  }

  for (const d of defaults) {
    const email = normalizeEmail(d.email);
    if (!email || emailIndex.has(email)) continue;
    const id = userIdForEmail(email);
    const row = {
      id,
      email,
      full_name: d.full_name,
      role: ROLE_SET.has(d.role) ? d.role : 'employee',
      created_at: now,
      updated_at: now
    };
    byId.set(id, row);
    emailIndex.set(email, id);
    inviteEmail(email);
    setRoleForEmail(email, row.role);
  }

  // Re-assert dedicated ratchet accounts after bulk invite seed (invite list
  // may have added them as employee first — force the documented roles).
  forceRole(RATCHET_ADMIN_EMAIL, 'admin', 'Ratchet Admin');
  forceRole(RATCHET_EMPLOYEE_EMAIL, 'employee', 'Ratchet Employee');
  if (envAdmin) forceRole(envAdmin, 'admin', 'Admin Test');
  if (envBoard) forceRole(envBoard, 'board_member', 'Board Member Test');
  forceRole('admin.e2e@boardroom.test', 'admin', 'Admin E2E');
  forceRole('founder.e2e@boardroom.test', 'admin', 'Founder E2E');
  forceRole('board_member.e2e@boardroom.test', 'board_member', 'Board Member E2E');
  forceRole('board.e2e@boardroom.test', 'board_member', 'Board E2E');
  forceRole('jason@readysignal.com', 'admin', 'Operator Admin');
}

function forceRole(email, role, fullName) {
  const normalized = normalizeEmail(email);
  if (!normalized) return;
  const id = emailIndex.get(normalized) || userIdForEmail(normalized);
  const existing = byId.get(id);
  const now = nowIso();
  if (existing) {
    existing.role = role;
    if (fullName && !existing.full_name) existing.full_name = fullName;
    existing.updated_at = now;
  } else {
    const row = {
      id,
      email: normalized,
      full_name: fullName || null,
      role,
      created_at: now,
      updated_at: now
    };
    byId.set(id, row);
    emailIndex.set(normalized, id);
  }
  inviteEmail(normalized);
  setRoleForEmail(normalized, role);
}

function ensureMemoryReady(env = process.env) {
  if (memoryReady) return;
  seedStaticUsers(env);
  memoryReady = true;
}

export function resetUsersStore() {
  byId = new Map();
  emailIndex = new Map();
  memoryReady = false;
}

// ---------------------------------------------------------------------------
// Postgres helpers
// ---------------------------------------------------------------------------
async function ensureDb() {
  await applyMigrations();
  // Guarantee ratchet test accounts exist (idempotent upsert by email).
  await seedDbTestAccounts();
}

async function seedDbTestAccounts(env = process.env) {
  const seeds = [
    [RATCHET_ADMIN_EMAIL, 'Ratchet Admin', 'admin'],
    [RATCHET_EMPLOYEE_EMAIL, 'Ratchet Employee', 'employee'],
    ['admin.e2e@boardroom.test', 'Admin E2E', 'admin'],
    ['board_member.e2e@boardroom.test', 'Board Member E2E', 'board_member']
  ];
  const envAdmin =
    (env.ADMIN_TEST_EMAIL || env.FOUNDER_TEST_EMAIL || '').trim().toLowerCase();
  const envBoard = (
    env.BOARD_MEMBER_TEST_EMAIL ||
    env.BOARD_TEST_EMAIL ||
    ''
  )
    .trim()
    .toLowerCase();
  if (envAdmin) seeds.push([envAdmin, 'Admin Test', 'admin']);
  if (envBoard) seeds.push([envBoard, 'Board Member Test', 'board_member']);

  for (const [email, fullName, role] of seeds) {
    const id = userIdForEmail(email);
    inviteEmail(email);
    await query(
      `
      insert into public.users (id, email, full_name, role)
      values ($1::uuid, $2, $3, $4)
      on conflict (email) do update
        set role = excluded.role,
            full_name = coalesce(public.users.full_name, excluded.full_name)
      `,
      [id, email, fullName, role]
    ).catch(async () => {
      // Some schemas use gen_random_uuid() PKs without accepting our id, or
      // email unique only — fall back to email-keyed upsert without id.
      await query(
        `
        insert into public.users (email, full_name, role)
        values ($1, $2, $3)
        on conflict (email) do update
          set role = excluded.role,
              full_name = coalesce(public.users.full_name, excluded.full_name)
        `,
        [email, fullName, role]
      ).catch((err) => {
        console.error('[usersStore] seed upsert failed:', err && err.message);
      });
    });
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function ensureUsersReady(env = process.env) {
  if (isDatabaseConfigured(env)) {
    try {
      await ensureDb();
      return { ok: true, source: 'database' };
    } catch (err) {
      console.error('[usersStore] db ensure failed, using memory:', err && err.message);
      ensureMemoryReady(env);
      return { ok: false, fallback: 'memory', error: err && err.message };
    }
  }
  ensureMemoryReady(env);
  return { ok: true, source: 'memory' };
}

export function hasUserEmail(email, env = process.env) {
  const normalized = normalizeEmail(email);
  if (!normalized) return false;
  if (!isDatabaseConfigured(env)) {
    ensureMemoryReady(env);
    return emailIndex.has(normalized);
  }
  // Sync path for invite checks when DB is bound: also consult memory seed so
  // OTP works before async ensure finishes; DB truth is used by list/create.
  ensureMemoryReady(env);
  return emailIndex.has(normalized);
}

/** Synchronous memory lookup (always available; used by the auth hook hot path). */
export function resolveStoredRoleSync(
  { userId = null, email = null } = {},
  env = process.env
) {
  ensureMemoryReady(env);
  if (userId && byId.has(userId)) {
    return byId.get(userId).role;
  }
  if (email) {
    const id = emailIndex.get(normalizeEmail(email));
    if (id && byId.has(id)) return byId.get(id).role;
  }
  return null;
}

/** Resolve the live role for a session identity. Returns null if unknown. */
export async function resolveStoredRole({ userId = null, email = null } = {}, env = process.env) {
  if (isDatabaseConfigured(env)) {
    try {
      await ensureDb();
      if (userId) {
        const res = await query(
          `select role from public.users where id = $1::uuid limit 1`,
          [userId]
        );
        if (res.rows[0]?.role && ROLE_SET.has(res.rows[0].role)) {
          return res.rows[0].role;
        }
      }
      if (email) {
        const res = await query(
          `select role from public.users where lower(email) = lower($1) limit 1`,
          [normalizeEmail(email)]
        );
        if (res.rows[0]?.role && ROLE_SET.has(res.rows[0].role)) {
          return res.rows[0].role;
        }
      }
    } catch (err) {
      console.error('[usersStore] resolveStoredRole db failed:', err && err.message);
      // fall through to memory
    }
  }
  return resolveStoredRoleSync({ userId, email }, env);
}

export async function listUsers(env = process.env) {
  if (isDatabaseConfigured(env)) {
    try {
      await ensureDb();
      const res = await query(
        `
        select id::text as id, email, full_name, role,
               created_at, created_at as updated_at
        from public.users
        order by lower(email) asc
        `
      );
      return res.rows.map(publicUser);
    } catch (err) {
      console.error('[usersStore] listUsers db failed:', err && err.message);
    }
  }
  ensureMemoryReady(env);
  return [...byId.values()]
    .map(publicUser)
    .sort((a, b) => a.email.localeCompare(b.email));
}

export async function getUserById(id, env = process.env) {
  if (!id) return null;
  if (isDatabaseConfigured(env)) {
    try {
      await ensureDb();
      const res = await query(
        `
        select id::text as id, email, full_name, role,
               created_at, created_at as updated_at
        from public.users where id = $1::uuid limit 1
        `,
        [id]
      );
      if (res.rows[0]) return publicUser(res.rows[0]);
    } catch (err) {
      console.error('[usersStore] getUserById db failed:', err && err.message);
    }
  }
  ensureMemoryReady(env);
  return publicUser(byId.get(id) || null);
}

export async function createUser(
  { email, full_name = null, role = 'employee' } = {},
  env = process.env
) {
  const normalized = normalizeEmail(email);
  if (!normalized || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
    const err = new Error('invalid email');
    err.code = 'VALIDATION';
    throw err;
  }
  if (!ROLE_SET.has(role)) {
    const err = new Error(
      `role must be one of: ${GOVERNANCE_ROLES.join(', ')}`
    );
    err.code = 'VALIDATION';
    throw err;
  }

  inviteEmail(normalized);

  if (isDatabaseConfigured(env)) {
    try {
      await ensureDb();
      const existing = await query(
        `select id::text as id from public.users where lower(email) = lower($1) limit 1`,
        [normalized]
      );
      if (existing.rows[0]) {
        const err = new Error('email already exists');
        err.code = 'CONFLICT';
        throw err;
      }
      const id = userIdForEmail(normalized);
      let res;
      try {
        res = await query(
          `
          insert into public.users (id, email, full_name, role)
          values ($1::uuid, $2, $3, $4)
          returning id::text as id, email, full_name, role, created_at,
                    created_at as updated_at
          `,
          [id, normalized, full_name || null, role]
        );
      } catch {
        res = await query(
          `
          insert into public.users (email, full_name, role)
          values ($1, $2, $3)
          returning id::text as id, email, full_name, role, created_at,
                    created_at as updated_at
          `,
          [normalized, full_name || null, role]
        );
      }
      // Keep memory mirror in sync for sync invite checks.
      const row = res.rows[0];
      ensureMemoryReady(env);
      byId.set(row.id, {
        id: row.id,
        email: row.email,
        full_name: row.full_name,
        role: row.role,
        created_at: row.created_at,
        updated_at: row.updated_at || row.created_at
      });
      emailIndex.set(normalizeEmail(row.email), row.id);
      setRoleForEmail(row.email, row.role);
      return publicUser(row);
    } catch (err) {
      if (err && (err.code === 'CONFLICT' || err.code === 'VALIDATION')) throw err;
      console.error('[usersStore] createUser db failed:', err && err.message);
      // fall through to memory
    }
  }

  ensureMemoryReady(env);
  if (emailIndex.has(normalized)) {
    const err = new Error('email already exists');
    err.code = 'CONFLICT';
    throw err;
  }
  const now = nowIso();
  const id = userIdForEmail(normalized);
  const row = {
    id,
    email: normalized,
    full_name: full_name || null,
    role,
    created_at: now,
    updated_at: now
  };
  byId.set(id, row);
  emailIndex.set(normalized, id);
  setRoleForEmail(normalized, role);
  return publicUser(row);
}

export async function updateUser(id, patch = {}, env = process.env) {
  if (!id) {
    const err = new Error('user id required');
    err.code = 'VALIDATION';
    throw err;
  }
  const updates = {};
  if (Object.prototype.hasOwnProperty.call(patch, 'full_name')) {
    updates.full_name =
      patch.full_name === null || patch.full_name === undefined
        ? null
        : String(patch.full_name);
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'email')) {
    const normalized = normalizeEmail(patch.email);
    if (!normalized || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
      const err = new Error('invalid email');
      err.code = 'VALIDATION';
      throw err;
    }
    updates.email = normalized;
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'role')) {
    if (!ROLE_SET.has(patch.role)) {
      const err = new Error(
        `role must be one of: ${GOVERNANCE_ROLES.join(', ')}`
      );
      err.code = 'VALIDATION';
      throw err;
    }
    updates.role = patch.role;
  }
  if (Object.keys(updates).length === 0) {
    const err = new Error('no fields to update');
    err.code = 'VALIDATION';
    throw err;
  }

  if (isDatabaseConfigured(env)) {
    try {
      await ensureDb();
      if (updates.email) {
        const clash = await query(
          `
          select id::text as id from public.users
          where lower(email) = lower($1) and id <> $2::uuid
          limit 1
          `,
          [updates.email, id]
        );
        if (clash.rows[0]) {
          const err = new Error('email already exists');
          err.code = 'CONFLICT';
          throw err;
        }
      }
      const sets = [];
      const params = [];
      let i = 1;
      for (const [k, v] of Object.entries(updates)) {
        sets.push(`${k} = $${i++}`);
        params.push(v);
      }
      params.push(id);
      const res = await query(
        `
        update public.users
        set ${sets.join(', ')}
        where id = $${i}::uuid
        returning id::text as id, email, full_name, role, created_at,
                  created_at as updated_at
        `,
        params
      );
      if (!res.rows[0]) {
        const err = new Error('user not found');
        err.code = 'NOT_FOUND';
        throw err;
      }
      const row = res.rows[0];
      if (updates.email) inviteEmail(updates.email);
      ensureMemoryReady(env);
      // Refresh memory mirror
      for (const [em, mid] of [...emailIndex.entries()]) {
        if (mid === row.id) emailIndex.delete(em);
      }
      byId.set(row.id, {
        id: row.id,
        email: row.email,
        full_name: row.full_name,
        role: row.role,
        created_at: row.created_at,
        updated_at: row.updated_at || row.created_at
      });
      emailIndex.set(normalizeEmail(row.email), row.id);
      setRoleForEmail(row.email, row.role);
      return publicUser(row);
    } catch (err) {
      if (
        err &&
        (err.code === 'CONFLICT' ||
          err.code === 'VALIDATION' ||
          err.code === 'NOT_FOUND')
      ) {
        throw err;
      }
      console.error('[usersStore] updateUser db failed:', err && err.message);
    }
  }

  ensureMemoryReady(env);
  const existing = byId.get(id);
  if (!existing) {
    const err = new Error('user not found');
    err.code = 'NOT_FOUND';
    throw err;
  }
  if (updates.email && updates.email !== existing.email) {
    if (emailIndex.has(updates.email)) {
      const err = new Error('email already exists');
      err.code = 'CONFLICT';
      throw err;
    }
    emailIndex.delete(existing.email);
    emailIndex.set(updates.email, id);
    inviteEmail(updates.email);
    existing.email = updates.email;
  }
  if (Object.prototype.hasOwnProperty.call(updates, 'full_name')) {
    existing.full_name = updates.full_name;
  }
  if (updates.role) {
    existing.role = updates.role;
  }
  existing.updated_at = nowIso();
  setRoleForEmail(existing.email, existing.role);
  return publicUser(existing);
}

export function governanceRolesList() {
  return [...GOVERNANCE_ROLES];
}

/** Human labels for the five roles (page source / selector verification). */
export const ROLE_LABELS = Object.freeze({
  admin: 'admin',
  executive: 'executive',
  board_member: 'board member',
  employee: 'employee',
  consultant: 'consultant'
});
