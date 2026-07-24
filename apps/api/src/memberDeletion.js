// Fail-closed, two-step deletion of members.  Relationship discovery is taken
// from Postgres' FK catalog rather than a hand-maintained table list, so a new
// reference to public.users cannot be silently missed.
import crypto from 'node:crypto';
import { getPool, isDatabaseConfigured } from './db.js';
import { getUserById, removeMemoryUser } from './usersStore.js';

const confirmations = new Map();
const TTL_MS = 5 * 60 * 1000;
const MEMORY_RELATIONSHIPS = Object.freeze([
  'public.kpi_values.recorded_by', 'public.memos.author_id',
  'public.analyses.author_id', 'public.comments.author_id',
  'public.comments.deleted_by', 'public.agendas.created_by',
  'public.audit_log.actor_id', 'public.comment_reactions.user_id',
  'public.kpi_import_attempts.administrator_id'
]);

function qident(value) { return `"${String(value).replace(/"/g, '""')}"`; }
function digest(value) { return crypto.createHash('sha256').update(value).digest('base64url'); }
function relationshipKey(row) { return `${row.schema}.${row.table}.${row.column}`; }

async function dbRelationships(client, memberId) {
  const found = await client.query(`
    select ns.nspname as schema, cls.relname as table, att.attname as column,
           con.confdeltype as delete_action
      from pg_constraint con
      join pg_class cls on cls.oid = con.conrelid
      join pg_namespace ns on ns.oid = cls.relnamespace
      join pg_attribute att on att.attrelid = cls.oid and att.attnum = con.conkey[1]
      join pg_class target on target.oid = con.confrelid
      join pg_namespace target_ns on target_ns.oid = target.relnamespace
     where con.contype = 'f' and target_ns.nspname = 'public' and target.relname = 'users'
     order by ns.nspname, cls.relname, att.attname
  `);
  const rows = [];
  for (const rel of found.rows) {
    const count = await client.query(
      `select count(*)::int as count from ${qident(rel.schema)}.${qident(rel.table)} where ${qident(rel.column)} = $1::uuid`,
      [memberId]
    );
    // We intentionally never rely on SET NULL/CASCADE: deletion only proceeds
    // when no relationship exists, avoiding an implicit detach or data loss.
    rows.push({
      relationship: relationshipKey(rel), count: count.rows[0].count,
      disposition: 'block', delete_action: rel.delete_action
    });
  }
  return rows;
}

function memoryRelationships() {
  return MEMORY_RELATIONSHIPS.map((relationship) => ({ relationship, count: 0, disposition: 'block', delete_action: null }));
}

function assessment(member, relationships) {
  const blocking_reasons = relationships.filter((r) => r.count > 0)
    .map((r) => ({ relationship: r.relationship, count: r.count, reason: 'related_records_block_deletion' }));
  return {
    member_id: member.id,
    related_counts: Object.fromEntries(relationships.map((r) => [r.relationship, r.count])),
    relationships,
    allowed: blocking_reasons.length === 0,
    blocking_reasons
  };
}

function snapshot(a) {
  return digest(JSON.stringify({ member_id: a.member_id, related_counts: a.related_counts }));
}

export async function assessMemberDeletion(memberId) {
  const member = await getUserById(memberId);
  if (!member) return null;
  let relationships;
  if (isDatabaseConfigured()) {
    const pool = getPool();
    if (!pool) throw new Error('database unavailable');
    relationships = await dbRelationships(pool, member.id);
  } else relationships = memoryRelationships();
  const result = assessment(member, relationships);
  const confirmation = crypto.randomBytes(32).toString('base64url');
  confirmations.set(digest(confirmation), {
    member_id: member.id, state: snapshot(result), expires_at: Date.now() + TTL_MS
  });
  return { ...result, confirmation, confirmation_expires_at: new Date(Date.now() + TTL_MS).toISOString() };
}

export async function confirmMemberDeletion(memberId, confirmation) {
  if (!confirmation || typeof confirmation !== 'string') return { outcome: 'unassessed' };
  const key = digest(confirmation);
  const record = confirmations.get(key);
  // Consume every supplied confirmation exactly once, including stale/bad target.
  confirmations.delete(key);
  if (!record || record.member_id !== memberId || record.expires_at <= Date.now()) return { outcome: 'invalid_confirmation' };

  if (isDatabaseConfigured()) {
    const pool = getPool();
    if (!pool) throw new Error('database unavailable');
    const client = await pool.connect();
    try {
      await client.query('begin');
      const member = await client.query('select id::text as id, email, full_name, role, created_at from public.users where id = $1::uuid for update', [memberId]);
      if (!member.rows[0]) { await client.query('rollback'); return { outcome: 'not_found' }; }
      const current = assessment(member.rows[0], await dbRelationships(client, memberId));
      if (snapshot(current) !== record.state || !current.allowed) { await client.query('rollback'); return { outcome: 'stale_or_blocked', assessment: current }; }
      await client.query('delete from public.users where id = $1::uuid', [memberId]);
      await client.query('commit');
      return { outcome: 'deleted', member_id: memberId };
    } catch (err) {
      try { await client.query('rollback'); } catch { /* ignored */ }
      throw err;
    } finally { client.release(); }
  }

  const member = await getUserById(memberId);
  if (!member) return { outcome: 'not_found' };
  const current = assessment(member, memoryRelationships());
  if (snapshot(current) !== record.state || !current.allowed) return { outcome: 'stale_or_blocked', assessment: current };
  removeMemoryUser(memberId);
  return { outcome: 'deleted', member_id: memberId };
}

export function resetMemberDeletionConfirmations() { confirmations.clear(); }
