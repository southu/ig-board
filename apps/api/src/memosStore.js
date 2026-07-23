// Boardroom founder memo store — private upload pipeline authority.
//
// Why this exists (and why it is in-memory): the live deployment runs with NO
// external Supabase project bound (isAdminConfigured() === false), so the
// canonical `memos` table + private Storage bucket are unreachable. This module
// is the faithful in-process realization of that contract:
//   * founders upload .docx / .pdf with a meeting_date
//   * rows carry storage_path, meeting_date, status (uploaded → analyzed),
//     extracted_text
//   * board may read only — never insert
//   * file bytes live only in process memory (never a public URL)
//   * signed URLs (see signedStorage.js) are the sole download path
//
// State is module-scoped so every request in the Railway process shares it
// (what the live tester needs within a deploy lifetime) and starts fresh on
// each boot. Tests reset with resetMemosStore().

import crypto from 'node:crypto';

let state = freshState();

function freshState() {
  return {
    // id -> memo row (metadata only; bytes live in blobs)
    memos: new Map(),
    // storage_path -> { buffer, contentType, originalFilename }
    blobs: new Map()
  };
}

export function resetMemosStore() {
  state = freshState();
}

function nextId() {
  // uuid-shaped id without depending on crypto.randomUUID availability quirks
  return crypto.randomUUID
    ? crypto.randomUUID()
    : `memo_${Date.now().toString(36)}_${crypto.randomBytes(6).toString('hex')}`;
}

// Public shape returned by the API (never includes raw file bytes).
export function publicMemo(row) {
  if (!row) return null;
  return {
    id: row.id,
    author_id: row.author_id,
    title: row.title,
    storage_path: row.storage_path,
    meeting_date: row.meeting_date,
    status: row.status,
    extracted_text: row.extracted_text,
    original_filename: row.original_filename,
    content_type: row.content_type,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

// Create a memo in status `uploaded` and store the private blob. Pure server-
// side; callers run extraction and flip status to `analyzed` afterwards.
export function createMemo({
  authorId,
  meetingDate,
  originalFilename,
  contentType,
  buffer
}) {
  const id = nextId();
  const now = new Date().toISOString();
  const safeName = sanitizeFilename(originalFilename || 'memo.bin');
  // storage_path is opaque and private — never a public URL path alone.
  const storage_path = `memos/${id}/${safeName}`;
  const row = {
    id,
    author_id: authorId || null,
    title: safeName,
    storage_path,
    meeting_date: meetingDate,
    status: 'uploaded',
    extracted_text: null,
    original_filename: safeName,
    content_type: contentType || 'application/octet-stream',
    created_at: now,
    updated_at: now
  };
  state.memos.set(id, row);
  state.blobs.set(storage_path, {
    buffer: Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []),
    contentType: row.content_type,
    originalFilename: safeName
  });
  return publicMemo(row);
}

// Mark a memo analyzed with non-empty extracted text (or empty string if the
// extractor found nothing — callers should prefer non-empty for acceptance).
export function markAnalyzed(id, extractedText) {
  const row = state.memos.get(id);
  if (!row) return null;
  row.extracted_text =
    typeof extractedText === 'string' ? extractedText : String(extractedText || '');
  row.status = 'analyzed';
  row.updated_at = new Date().toISOString();
  state.memos.set(id, row);
  return publicMemo(row);
}

export function getMemo(id) {
  return publicMemo(state.memos.get(id) || null);
}

export function listMemos() {
  return [...state.memos.values()]
    .map(publicMemo)
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
}

export function getBlob(storagePath) {
  return state.blobs.get(storagePath) || null;
}

export function memoCount() {
  return state.memos.size;
}

// Strip path separators and control chars so a storage path stays a single
// object key under memos/<id>/.
function sanitizeFilename(name) {
  const base = String(name || 'memo.bin')
    .replace(/[/\\]+/g, '_')
    .replace(/[^\w.\- ()[\]]+/g, '_')
    .replace(/^\.+/, '')
    .trim();
  return base.slice(0, 180) || 'memo.bin';
}

// Accept YYYY-MM-DD only (the meeting_date contract). Returns '' if invalid.
export function normalizeMeetingDate(value) {
  const s = String(value == null ? '' : value).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return '';
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return '';
  // Round-trip to catch invalid calendar dates (e.g. 2026-02-31).
  if (d.toISOString().slice(0, 10) !== s) return '';
  return s;
}
