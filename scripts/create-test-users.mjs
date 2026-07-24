#!/usr/bin/env node
// Create the invite-only Boardroom test users (admin + board_member) used for
// live end-to-end checks. This is the documented admin/seed path referenced by
// TESTING.md.
//
// It is idempotent: re-running converges to the same users with the correct
// role. It creates each Supabase auth user WITHOUT a password (invite-only —
// operators sign in with a magic link / OTP), sets `app_metadata.role` so the
// issued JWT carries the app role the API reads, and upserts the matching
// `public.users` row (id = auth user id) so RLS resolves the role.
//
// Secrets (SUPABASE_SERVICE_ROLE_KEY) are read from the environment ONLY and are
// never printed. No password or token is ever created, logged, or committed.
//
// Usage:
//   SUPABASE_URL=https://<ref>.supabase.co \
//   SUPABASE_SERVICE_ROLE_KEY=<service-role-key-from-vault> \
//   [ADMIN_TEST_EMAIL=admin.e2e@boardroom.test] \
//   [BOARD_MEMBER_TEST_EMAIL=board_member.e2e@boardroom.test] \
//   [FOUNDER_TEST_EMAIL=...] [BOARD_TEST_EMAIL=...] \
//   node scripts/create-test-users.mjs
import { adminConfig, adminFetch } from '../apps/api/src/supabaseAdmin.js';

// Non-secret defaults; override via env to point at real invite-capable inboxes.
// Governance roles (admin | board_member) match apps/api/src/permissions.js.
const USERS = [
  {
    role: 'admin',
    email: (
      process.env.ADMIN_TEST_EMAIL ||
      process.env.FOUNDER_TEST_EMAIL ||
      'admin.e2e@boardroom.test'
    ).trim(),
    full_name: 'Boardroom E2E Admin'
  },
  {
    role: 'board_member',
    email: (
      process.env.BOARD_MEMBER_TEST_EMAIL ||
      process.env.BOARD_TEST_EMAIL ||
      'board_member.e2e@boardroom.test'
    ).trim(),
    full_name: 'Boardroom E2E Board Member'
  }
];

async function readJson(res) {
  const text = await res.text();
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return text;
  }
}

// Find an existing auth user by email (admin list is paginated; scan a page).
async function findAuthUser(email) {
  const res = await adminFetch(`/auth/v1/admin/users?page=1&per_page=200`, { method: 'GET' });
  if (!res.ok) throw new Error(`list users failed: ${res.status} ${JSON.stringify(await readJson(res))}`);
  const body = await readJson(res);
  const list = Array.isArray(body?.users) ? body.users : Array.isArray(body) ? body : [];
  return list.find((u) => (u.email || '').toLowerCase() === email.toLowerCase()) || null;
}

// Create (or fetch) the auth user and ensure app_metadata.role is set.
async function ensureAuthUser({ email, role }) {
  const create = await adminFetch('/auth/v1/admin/users', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, email_confirm: true, app_metadata: { role } }),
  });

  let user;
  if (create.ok) {
    user = await readJson(create);
  } else if (create.status === 422 || create.status === 409) {
    // Already exists — fetch it, then patch the role to be safe.
    user = await findAuthUser(email);
    if (!user) throw new Error(`user ${email} reported existing but not found`);
  } else {
    throw new Error(`create user ${email} failed: ${create.status} ${JSON.stringify(await readJson(create))}`);
  }

  if (user?.app_metadata?.role !== role) {
    const patch = await adminFetch(`/auth/v1/admin/users/${user.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_metadata: { role } }),
    });
    if (!patch.ok) throw new Error(`set role for ${email} failed: ${patch.status}`);
    user = await readJson(patch);
  }
  return user;
}

// Upsert the public.users row (id must equal the auth user id) so RLS resolves.
async function upsertPublicUser({ id, email, role, full_name }) {
  const res = await adminFetch('/rest/v1/users?on_conflict=id', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify({ id, email, role, full_name }),
  });
  if (!res.ok) throw new Error(`upsert public.users ${email} failed: ${res.status} ${JSON.stringify(await readJson(res))}`);
}

async function main() {
  adminConfig(); // fail closed early if unconfigured
  for (const spec of USERS) {
    const authUser = await ensureAuthUser(spec);
    await upsertPublicUser({ id: authUser.id, email: spec.email, role: spec.role, full_name: spec.full_name });
    // Only non-secret fields are printed: email, role, and the auth user id.
    console.log(`ok  ${spec.role.padEnd(7)} ${spec.email}  (id ${authUser.id})`);
  }
  console.log('done — send each user a magic link to obtain a JWT for /me checks (never commit the link).');
}

main().catch((err) => {
  console.error(`error: ${err.message}`);
  process.exit(1);
});
