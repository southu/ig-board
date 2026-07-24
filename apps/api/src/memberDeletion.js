// Fail-closed, two-step deletion of members.  Relationship discovery is taken
// from Postgres' FK catalog rather than a hand-maintained table list, so a new
// reference to public.users cannot be silently missed.
import crypto from 'node:crypto';
import { getPool, isDatabaseConfigured } from './db.js';
import { getUserById, removeMemoryUser } from './usersStore.js';
import { countKpiValuesRecordedBy } from './store.js';
import { countMemberCommentReferences } from './commentsStore.js';

const confirmations = new Map();
const TTL_MS = 5 * 60 * 1000;
let forceFailureForTest = false;
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
  // Catalog FKs are authoritative where present, but old Railway databases
  // can predate an FK/column migration.  The known logical dependencies are
  // included as well, so schema drift cannot turn related data into an
  // invisible, implicitly-detached dependency.
  const catalog = new Map(found.rows.map((rel) => [relationshipKey(rel), rel]));
  for (const relationship of MEMORY_RELATIONSHIPS) {
    if (!catalog.has(relationship)) {
      const [, table, column] = relationship.split('.');
      catalog.set(relationship, { schema: 'public', table, column, delete_action: null });
    }
  }
  const existing = await client.query(`
    select table_schema as schema, table_name as table, column_name as column
      from information_schema.columns
     where table_schema = 'public'
  `);
  const columns = new Set(existing.rows.map(relationshipKey));
  const rows = [];
  for (const rel of [...catalog.values()].sort((a, b) => relationshipKey(a).localeCompare(relationshipKey(b)))) {
    const key = relationshipKey(rel);
    // A missing historical table/column has no rows; retain the stable key so
    // clients can distinguish zero from an omitted relationship.
    if (!columns.has(key)) {
      rows.push({ relationship: key, count: 0, disposition: 'block', delete_action: rel.delete_action });
      continue;
    }
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

function memoryRelationships(member) {
  const comments = countMemberCommentReferences(member.id);
  const counts = {
    'public.kpi_values.recorded_by': countKpiValuesRecordedBy(member.id, member.email),
    'public.comments.author_id': comments.author,
    'public.comments.deleted_by': comments.deletedBy,
    'public.comment_reactions.user_id': comments.reactions
  };
  return MEMORY_RELATIONSHIPS.map((relationship) => ({
    relationship,
    count: counts[relationship] || 0,
    disposition: 'block', delete_action: null
  }));
}

function assessment(member, relationships) {
  const blocking_reasons = relationships.filter((r) => r.count > 0)
    .map((r) => ({ relationship: r.relationship, count: r.count, reason: 'related_records_block_deletion' }));
  return {
    member_id: member.id,
    member: {
      email: member.email || null,
      full_name: member.full_name || null,
      role: member.role || null
    },
    related_counts: Object.fromEntries(relationships.map((r) => [r.relationship, r.count])),
    relationships,
    allowed: blocking_reasons.length === 0,
    blocking_reasons
  };
}

function snapshot(a) {
  // A confirmation must represent the exact member record the administrator
  // reviewed, not merely its id. Editing the name, email, or role while the
  // dialog is open therefore makes the confirmation stale.
  return digest(JSON.stringify({ member_id: a.member_id, member: a.member, related_counts: a.related_counts }));
}

export async function assessMemberDeletion(memberId) {
  const member = await getUserById(memberId);
  if (!member) return null;
  let relationships;
  if (isDatabaseConfigured()) {
    const pool = getPool();
    if (!pool) throw new Error('database unavailable');
    relationships = await dbRelationships(pool, member.id);
  } else relationships = memoryRelationships(member);
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
      if (forceFailureForTest) throw new Error('forced member deletion failure');
      await client.query('commit');
      // The local mirror is only a cache for invite/auth flows.  Keep it in
      // sync after the committed transaction so detail and list cannot diverge.
      removeMemoryUser(memberId);
      return { outcome: 'deleted', member_id: memberId };
    } catch (err) {
      try { await client.query('rollback'); } catch { /* ignored */ }
      throw err;
    } finally { client.release(); }
  }

  const member = await getUserById(memberId);
  if (!member) return { outcome: 'not_found' };
  const current = assessment(member, memoryRelationships(member));
  if (snapshot(current) !== record.state || !current.allowed) return { outcome: 'stale_or_blocked', assessment: current };
  if (forceFailureForTest) throw new Error('forced member deletion failure');
  removeMemoryUser(memberId);
  return { outcome: 'deleted', member_id: memberId };
}

export function resetMemberDeletionConfirmations() { confirmations.clear(); }

// Test-only fault injection: the setter is never called by application code,
// and lets the suite verify that a failed confirmation leaves the member intact.
export function setMemberDeletionFailureForTest(enabled) { forceFailureForTest = Boolean(enabled); }
