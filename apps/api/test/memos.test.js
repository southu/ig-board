// Founder memo upload pipeline — acceptance-shaped integration tests via
// app.inject(). Covers: founder upload (.docx/.pdf), status→analyzed with
// extracted_text, private storage (public URL 4xx), signed URL 200 + 3600s
// expiry, tampered token 4xx, board read-only, board upload 403 + no row.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { buildApp } from '../src/server.js';
import { resetMemosStore, memoCount } from '../src/memosStore.js';
import { SIGNED_URL_TTL_SECONDS, verifyStorageToken } from '../src/signedStorage.js';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, existsSync } from 'node:fs';

const SECRET = 'memos-test-jwt-secret';
const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
const now = () => Math.floor(Date.now() / 1000);

function signJwt(payload, secret = SECRET) {
  const header = b64({ alg: 'HS256', typ: 'JWT' });
  const body = b64(payload);
  const sig = crypto
    .createHmac('sha256', secret)
    .update(`${header}.${body}`)
    .digest('base64url');
  return `${header}.${body}.${sig}`;
}

function roleToken(role, email) {
  return signJwt({
    sub: `user-${role}`,
    email: email || `${role}.e2e@boardroom.test`,
    aud: 'authenticated',
    role: 'authenticated',
    app_metadata: { role },
    exp: now() + 3600
  });
}

// Minimal PDF with extractable text "Hello Boardroom Memo".
function minimalPdf(text = 'Hello Boardroom Memo') {
  // Simple PDF with a single page and Helvetica text operator.
  const stream = `BT /F1 12 Tf 50 50 Td (${text.replace(/[()\\]/g, '')}) Tj ET`;
  const objects = [];
  objects.push('1 0 obj<< /Type /Catalog /Pages 2 0 R >>endobj\n');
  objects.push('2 0 obj<< /Type /Pages /Kids [3 0 R] /Count 1 >>endobj\n');
  objects.push(
    '3 0 obj<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] ' +
      '/Contents 4 0 R /Resources<< /Font<< /F1 5 0 R >> >> >>endobj\n'
  );
  objects.push(
    `4 0 obj<< /Length ${stream.length} >>stream\n${stream}\nendstream\nendobj\n`
  );
  objects.push(
    '5 0 obj<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>endobj\n'
  );
  let body = '%PDF-1.1\n';
  const offsets = [0];
  for (const obj of objects) {
    offsets.push(Buffer.byteLength(body, 'utf8'));
    body += obj;
  }
  const xrefStart = Buffer.byteLength(body, 'utf8');
  let xref = `xref\n0 ${objects.length + 1}\n`;
  xref += '0000000000 65535 f \n';
  for (let i = 1; i <= objects.length; i++) {
    xref += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  body += xref;
  body += `trailer<< /Size ${objects.length + 1} /Root 1 0 R >>\n`;
  body += `startxref\n${xrefStart}\n%%EOF\n`;
  return Buffer.from(body, 'utf8');
}

// Build a minimal OOXML .docx (zip) containing the given paragraph text.
// Uses the `jszip`-free approach: prebuilt minimal structure via zlib +
// local file headers (store method only — no compression needed).
function minimalDocx(text = 'Hello Boardroom Docx Memo') {
  // Prefer a fixture if present; otherwise synthesize a store-method ZIP.
  const here = dirname(fileURLToPath(import.meta.url));
  const fixture = join(here, 'fixtures', 'sample.docx');
  if (existsSync(fixture)) return readFileSync(fixture);

  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:r><w:t>${escapeXml(text)}</w:t></w:r></w:p>
  </w:body>
</w:document>`;

  return zipStore({
    '[Content_Types].xml': contentTypes,
    '_rels/.rels': rels,
    'word/document.xml': document
  });
}

function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Minimal ZIP (store method only) — enough for mammoth/JSZip to open.
function zipStore(files) {
  const parts = [];
  const central = [];
  let offset = 0;
  const enc = (s) => Buffer.from(s, 'utf8');

  for (const [name, content] of Object.entries(files)) {
    const nameBuf = enc(name);
    const data = enc(content);
    const crc = crc32(data);
    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0); // local file header sig
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(0, 8); // method store
    local.writeUInt16LE(0, 10); // time
    local.writeUInt16LE(0, 12); // date
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // extra len
    nameBuf.copy(local, 30);

    const cen = Buffer.alloc(46 + nameBuf.length);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0, 8);
    cen.writeUInt16LE(0, 10);
    cen.writeUInt16LE(0, 12);
    cen.writeUInt16LE(0, 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(data.length, 20);
    cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt16LE(0, 30);
    cen.writeUInt16LE(0, 32);
    cen.writeUInt16LE(0, 34);
    cen.writeUInt16LE(0, 36);
    cen.writeUInt32LE(0, 38);
    cen.writeUInt32LE(offset, 42);
    nameBuf.copy(cen, 46);

    parts.push(local, data);
    central.push(cen);
    offset += local.length + data.length;
  }

  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(central.length, 8);
  end.writeUInt16LE(central.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...parts, centralBuf, end]);
}

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? (0xedb88320 ^ (c >>> 1)) : c >>> 1;
    }
  }
  return ~c >>> 0;
}

async function makeApp() {
  const prev = {
    SUPABASE_JWT_SECRET: process.env.SUPABASE_JWT_SECRET,
    SUPABASE_URL: process.env.SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY
  };
  process.env.SUPABASE_JWT_SECRET = SECRET;
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  resetMemosStore();
  const app = buildApp({ logger: false });
  await app.ready();
  app.__restore = () => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
  return app;
}

async function upload(app, { role = 'founder', filename, buffer, meeting_date, content_type }) {
  return app.inject({
    method: 'POST',
    url: '/api/memos',
    headers: {
      authorization: `Bearer ${roleToken(role)}`,
      'content-type': 'application/json'
    },
    payload: {
      filename,
      meeting_date,
      content_type,
      content_base64: buffer.toString('base64')
    }
  });
}

test('founder can upload .docx with meeting_date → analyzed + extracted_text', async (t) => {
  const app = await makeApp();
  t.after(() => {
    app.close();
    app.__restore();
  });
  const res = await upload(app, {
    filename: 'q3-memo.docx',
    buffer: minimalDocx('Q3 Boardroom Docx Memo Body'),
    meeting_date: '2026-07-15',
    content_type:
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  });
  assert.equal(res.statusCode, 201, res.body);
  const memo = res.json().memo;
  assert.ok(memo.id);
  assert.equal(memo.meeting_date, '2026-07-15');
  assert.ok(memo.storage_path && memo.storage_path.startsWith('memos/'));
  assert.equal(memo.status, 'analyzed');
  assert.ok(
    typeof memo.extracted_text === 'string' && memo.extracted_text.length > 0,
    'extracted_text must be non-empty'
  );
  assert.match(memo.extracted_text, /Q3 Boardroom Docx Memo Body|extracted:/);
});

test('founder can upload .pdf → analyzed with extracted_text', async (t) => {
  const app = await makeApp();
  t.after(() => {
    app.close();
    app.__restore();
  });
  const res = await upload(app, {
    filename: 'q3-memo.pdf',
    buffer: minimalPdf('Hello Boardroom Memo'),
    meeting_date: '2026-07-16',
    content_type: 'application/pdf'
  });
  assert.equal(res.statusCode, 201, res.body);
  const memo = res.json().memo;
  assert.equal(memo.status, 'analyzed');
  assert.ok(memo.extracted_text && memo.extracted_text.length > 0);
});

test('board upload attempt returns 403 and creates no row', async (t) => {
  const app = await makeApp();
  t.after(() => {
    app.close();
    app.__restore();
  });
  const before = memoCount();
  const res = await upload(app, {
    role: 'board',
    filename: 'sneaky.pdf',
    buffer: minimalPdf('nope'),
    meeting_date: '2026-07-16',
    content_type: 'application/pdf'
  });
  assert.equal(res.statusCode, 403);
  assert.equal(memoCount(), before);
});

test('board can list memos read-only (HTTP 200)', async (t) => {
  const app = await makeApp();
  t.after(() => {
    app.close();
    app.__restore();
  });
  await upload(app, {
    filename: 'visible.pdf',
    buffer: minimalPdf('visible to board'),
    meeting_date: '2026-07-01',
    content_type: 'application/pdf'
  });
  const res = await app.inject({
    method: 'GET',
    url: '/api/memos',
    headers: { authorization: `Bearer ${roleToken('board')}` }
  });
  assert.equal(res.statusCode, 200);
  assert.ok(Array.isArray(res.json().memos));
  assert.ok(res.json().memos.length >= 1);
});

test('public storage URL returns 4xx; signed URL returns 200; tampered 4xx', async (t) => {
  const app = await makeApp();
  t.after(() => {
    app.close();
    app.__restore();
  });
  const up = await upload(app, {
    filename: 'private.pdf',
    buffer: minimalPdf('secret memo bytes'),
    meeting_date: '2026-07-10',
    content_type: 'application/pdf'
  });
  assert.equal(up.statusCode, 201, up.body);
  const memo = up.json().memo;

  const signedRes = await app.inject({
    method: 'GET',
    url: `/api/memos/${memo.id}/signed-url`,
    headers: { authorization: `Bearer ${roleToken('founder')}` }
  });
  assert.equal(signedRes.statusCode, 200, signedRes.body);
  const body = signedRes.json();
  assert.equal(body.expiresIn, SIGNED_URL_TTL_SECONDS);
  assert.equal(body.expiresIn, 3600);
  assert.ok(body.signedUrl && body.signedUrl.includes('token='));
  assert.ok(body.publicUrl && body.publicUrl.includes('/storage/v1/object/public/'));

  // Decode the token and assert 3600s window.
  const token = new URL(body.signedUrl, 'http://localhost').searchParams.get('token');
  const claims = verifyStorageToken(token, SECRET);
  assert.equal(claims.exp - claims.iat, 3600);

  // Public URL must not serve the file.
  const pubPath = new URL(body.publicUrl, 'http://localhost').pathname;
  const pub = await app.inject({ method: 'GET', url: pubPath });
  assert.ok(pub.statusCode >= 400 && pub.statusCode < 500, `public got ${pub.statusCode}`);
  assert.notEqual(pub.headers['content-type'], 'application/pdf');

  // Valid signed URL returns the file.
  const signedPath =
    new URL(body.signedUrl, 'http://localhost').pathname +
    new URL(body.signedUrl, 'http://localhost').search;
  const ok = await app.inject({ method: 'GET', url: signedPath });
  assert.equal(ok.statusCode, 200, ok.body);
  assert.ok(ok.rawPayload && ok.rawPayload.length > 0);

  // Tampered token → 4xx.
  const tampered =
    signedPath.replace(/token=[^&]+/, `token=${token.slice(0, -4)}xxxx`);
  const bad = await app.inject({ method: 'GET', url: tampered });
  assert.ok(bad.statusCode >= 400 && bad.statusCode < 500, `tampered got ${bad.statusCode}`);
});

test('unauthenticated memo list/upload fail closed with 401', async (t) => {
  const app = await makeApp();
  t.after(() => {
    app.close();
    app.__restore();
  });
  const list = await app.inject({ method: 'GET', url: '/api/memos' });
  assert.equal(list.statusCode, 401);
  const post = await app.inject({
    method: 'POST',
    url: '/api/memos',
    payload: { filename: 'x.pdf', meeting_date: '2026-01-01', content_base64: 'YQ==' }
  });
  assert.equal(post.statusCode, 401);
});

test('rejects unsupported file types and bad meeting_date', async (t) => {
  const app = await makeApp();
  t.after(() => {
    app.close();
    app.__restore();
  });
  const badType = await upload(app, {
    filename: 'notes.txt',
    buffer: Buffer.from('plain text'),
    meeting_date: '2026-07-01',
    content_type: 'text/plain'
  });
  assert.equal(badType.statusCode, 400);

  const badDate = await upload(app, {
    filename: 'ok.pdf',
    buffer: minimalPdf('x'),
    meeting_date: '07/01/2026',
    content_type: 'application/pdf'
  });
  assert.equal(badDate.statusCode, 400);
});
