// Server-side text extraction for founder memos.
//
// NEVER runs in the browser — upload handlers call this on the API process only.
//   * .docx  → mammoth.extractRawText
//   * .pdf   → pdf text extract (pdf-parse)
// Anything else fails closed with an empty string (caller still flips status
// to analyzed so the pipeline never stalls; non-empty text is required for
// acceptance on the supported types).

import { extname } from 'node:path';

// Lazy-load heavy parsers so unit tests that never touch them stay light, and
// a missing optional dep fails closed per-request rather than crashing boot.
async function loadMammoth() {
  const mod = await import('mammoth');
  return mod.default || mod;
}

async function loadPdfParse() {
  // pdf-parse is CJS; default export is the parse function.
  const mod = await import('pdf-parse');
  return mod.default || mod;
}

function extensionOf(filename, contentType) {
  const fromName = extname(String(filename || '')).toLowerCase();
  if (fromName) return fromName;
  const ct = String(contentType || '').toLowerCase();
  if (ct.includes('wordprocessingml') || ct.includes('msword')) return '.docx';
  if (ct.includes('pdf')) return '.pdf';
  return '';
}

// Extract plain text from a buffer. Returns a trimmed string (may be empty on
// failure). Never throws to the caller — logs via optional `log` and returns ''.
export async function extractMemoText({ buffer, originalFilename, contentType, log }) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
  if (buf.length === 0) return '';
  const ext = extensionOf(originalFilename, contentType);

  try {
    if (ext === '.docx') {
      const mammoth = await loadMammoth();
      const result = await mammoth.extractRawText({ buffer: buf });
      return String((result && result.value) || '').trim();
    }
    if (ext === '.pdf') {
      const pdfParse = await loadPdfParse();
      const result = await pdfParse(buf);
      return String((result && result.text) || '').trim();
    }
  } catch (err) {
    if (log && typeof log.warn === 'function') {
      log.warn(
        { err: err && err.message, ext },
        'memo text extraction failed'
      );
    }
    return '';
  }

  if (log && typeof log.warn === 'function') {
    log.warn({ ext, contentType }, 'unsupported memo type for extraction');
  }
  return '';
}

// True when the filename/content-type pair is an allowed upload.
export function isAllowedMemoFile(originalFilename, contentType) {
  const ext = extensionOf(originalFilename, contentType);
  return ext === '.docx' || ext === '.pdf';
}
