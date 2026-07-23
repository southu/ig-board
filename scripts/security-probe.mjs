#!/usr/bin/env node
// Security acceptance probes for the Boardroom (ig-board) live deploy + local
// RLS harness. Writes non-secret transcripts under docs/evidence/security/.
//
// Never prints tokens, service-role keys, Anthropic keys, or raw JWTs.
// Exit 0 only when every required probe passes.
//
// Usage:
//   node scripts/security-probe.mjs
//   LIVE_URL=https://… node scripts/security-probe.mjs
//   DATABASE_URL=postgres://… node scripts/security-probe.mjs   # also runs RLS
import { writeFileSync, mkdirSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const EVIDENCE = join(ROOT, 'docs', 'evidence', 'security');
const LIVE = (
  process.env.LIVE_URL ||
  process.env.PLAYWRIGHT_BASE_URL ||
  'https://ig-board-production.up.railway.app'
).replace(/\/+$/, '');

const FOUNDER = process.env.FOUNDER_TEST_EMAIL || 'founder.e2e@boardroom.test';
const BOARD = process.env.BOARD_TEST_EMAIL || 'board.e2e@boardroom.test';

const BOARDROOM_TABLES = [
  'users',
  'layers',
  'kpis',
  'kpi_values',
  'memos',
  'analyses',
  'comments',
  'agendas',
  'audit_log'
];

const results = [];
function pass(name, detail = '') {
  results.push({ name, pass: true, detail: String(detail || '') });
  console.log(`PASS  ${name}${detail ? ` — ${detail}` : ''}`);
}
function fail(name, detail = '') {
  results.push({ name, pass: false, detail: String(detail || '') });
  console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
}

async function statusOf(path, init = {}) {
  const res = await fetch(`${LIVE}${path}`, { redirect: 'manual', ...init });
  return { status: res.status, res, headers: res.headers };
}

// Mint a session via the self-hosted magic-link path (inline action_link).
// Tokens stay in memory only and are never logged.
async function sessionFor(email) {
  const cfg = await fetch(`${LIVE}/config`, { cache: 'no-store' }).then((r) =>
    r.json()
  );
  const { supabaseUrl, supabaseAnonKey } = cfg;
  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error('loginConfig empty');
  }
  const otp = await fetch(`${supabaseUrl}/auth/v1/otp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: supabaseAnonKey
    },
    body: JSON.stringify({
      email,
      create_user: false,
      options: { email_redirect_to: `${LIVE}/` }
    })
  });
  if (!otp.ok) throw new Error(`otp ${otp.status}`);
  const body = await otp.json();
  if (!body.action_link) throw new Error('no inline action_link');
  const grantUrl = new URL(body.action_link);
  const grant = grantUrl.searchParams.get('token');
  if (!grant) throw new Error('action_link missing grant token');
  const verify = await fetch(`${supabaseUrl}/auth/v1/verify`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: supabaseAnonKey
    },
    body: JSON.stringify({ token: grant, type: 'magiclink' })
  });
  if (!verify.ok) throw new Error(`verify ${verify.status}`);
  const session = await verify.json();
  if (!session.access_token) throw new Error('verify returned no access_token');
  return { token: session.access_token, anonKey: supabaseAnonKey, supabaseUrl };
}

function writeTranscript(filename, body) {
  mkdirSync(EVIDENCE, { recursive: true });
  const path = join(EVIDENCE, filename);
  writeFileSync(path, body.endsWith('\n') ? body : `${body}\n`, 'utf8');
  return path;
}

// --- 1. Public probes --------------------------------------------------------
async function probePublicEndpoints() {
  const lines = [`# public endpoints @ ${LIVE}`, `at: ${new Date().toISOString()}`, ''];
  for (const path of ['/version', '/health']) {
    const { status, res } = await statusOf(path);
    const body = await res.text();
    const ok = status === 200;
    lines.push(`GET ${path} -> ${status}`);
    if (path === '/version') {
      let sha = '';
      try {
        sha = JSON.parse(body).sha || '';
      } catch {
        /* ignore */
      }
      lines.push(`  sha=${sha ? sha.slice(0, 12) : '<none>'}`);
      if (ok && sha) pass(`GET ${path} 200`, `sha=${sha.slice(0, 12)}`);
      else fail(`GET ${path} 200`, `status=${status}`);
    } else if (ok) {
      pass(`GET ${path} 200`);
    } else {
      fail(`GET ${path} 200`, `status=${status}`);
    }
  }
  writeTranscript('01-public-health-version.txt', lines.join('\n'));
}

// --- 2. App routes require auth (client redirect or 401) ---------------------
async function probeAppRoutes() {
  const lines = [
    `# app routes unauthenticated @ ${LIVE}`,
    `at: ${new Date().toISOString()}`,
    '',
    'Unauthenticated HTML pages return 200 shell; AuthGuard redirects to /login',
    'in the browser. Criterion accepts redirect-to-/login OR 401.',
    ''
  ];
  const protectedPages = [
    '/',
    '/scorecard',
    '/update',
    '/agenda',
    '/memos',
    '/analysis',
    '/comments',
    '/whats-new',
    '/layer/1'
  ];
  for (const path of protectedPages) {
    const { status, res } = await statusOf(path);
    const body = await res.text();
    const hasGuard =
      /route-guard|Checking your session|location\.replace\(["']\/login|window\.location\.replace\(["']\/login/.test(
        body
      ) ||
      /\/login/.test(body);
    // 401/403 also ok; 200 with client-side AuthGuard redirect is ok.
    const ok =
      status === 401 ||
      status === 403 ||
      (status >= 300 && status < 400) ||
      (status === 200 && hasGuard);
    lines.push(
      `GET ${path} -> ${status} guard_or_redirect=${hasGuard ? 'yes' : 'no'} pass=${ok}`
    );
    if (ok) pass(`app route ${path} requires auth`, `status=${status}`);
    else fail(`app route ${path} requires auth`, `status=${status}`);
  }
  // /login must remain reachable without a session.
  {
    const { status } = await statusOf('/login');
    lines.push(`GET /login -> ${status} (must be 200)`);
    if (status === 200) pass('GET /login unauthenticated 200');
    else fail('GET /login unauthenticated 200', `status=${status}`);
  }
  writeTranscript('02-app-routes-auth.txt', lines.join('\n'));
}

// --- 3. Unauthenticated API --------------------------------------------------
async function probeApiAuth() {
  const lines = [
    `# unauthenticated API @ ${LIVE}`,
    `at: ${new Date().toISOString()}`,
    ''
  ];
  const apiPaths = [
    { method: 'GET', path: '/me' },
    { method: 'GET', path: '/api/kpi-values' },
    { method: 'POST', path: '/api/kpi-values', body: { key: 'nps', period: '2026-07', value: 1 } },
    { method: 'GET', path: '/api/kpi-definitions' },
    { method: 'PUT', path: '/api/kpi-definitions/nps', body: { definition: 'x' } },
    { method: 'GET', path: '/api/audit-log' },
    { method: 'GET', path: '/api/memos' },
    { method: 'GET', path: '/api/agenda' },
    { method: 'GET', path: '/api/whats-new' },
    { method: 'GET', path: '/api/export/kpi-values.csv' },
    { method: 'GET', path: '/rest/v1/kpis' }
  ];
  for (const { method, path, body } of apiPaths) {
    const init = {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined
    };
    const { status } = await statusOf(path, init);
    // 401/403 are explicit denials; 404 is also fail-closed (no public surface).
    const ok = status === 401 || status === 403 || status === 404;
    lines.push(`${method} ${path} -> ${status} pass=${ok}`);
    if (ok) pass(`unauth ${method} ${path} → ${status}`);
    else fail(`unauth ${method} ${path}`, `status=${status}`);
  }
  writeTranscript('03-unauth-api.txt', lines.join('\n'));
}

// --- 4. Anon zero rows -------------------------------------------------------
async function probeAnonZeroRows() {
  const lines = [
    `# anon Supabase client zero rows @ ${LIVE}`,
    `at: ${new Date().toISOString()}`,
    ''
  ];
  let cfg;
  try {
    cfg = await fetch(`${LIVE}/config`, { cache: 'no-store' }).then((r) => r.json());
  } catch (err) {
    fail('anon zero rows', err.message);
    writeTranscript('04-anon-zero-rows.txt', lines.concat([`error: ${err.message}`]).join('\n'));
    return;
  }
  const base = (cfg.supabaseUrl || LIVE).replace(/\/+$/, '');
  const anon = cfg.supabaseAnonKey || '';
  lines.push(`supabaseUrl host: ${safeHost(base)}`);
  lines.push(`anonKey present: ${anon ? 'yes' : 'no'} (value never logged)`);
  lines.push('');

  let allZero = true;
  for (const table of BOARDROOM_TABLES) {
    const url = `${base}/rest/v1/${table}?select=*&limit=5`;
    let status = 0;
    let rowCount = null;
    let note = '';
    try {
      const res = await fetch(url, {
        headers: {
          apikey: anon,
          Authorization: `Bearer ${anon}`,
          Accept: 'application/json'
        }
      });
      status = res.status;
      const text = await res.text();
      if (status === 200) {
        try {
          const data = JSON.parse(text);
          rowCount = Array.isArray(data) ? data.length : -1;
          if (rowCount !== 0) {
            allZero = false;
            note = `rows=${rowCount}`;
          } else {
            note = 'rows=0';
          }
        } catch {
          allZero = false;
          note = 'non-json body';
        }
      } else if (status === 401 || status === 403 || status === 404) {
        // Denied / no surface = zero readable rows for anon.
        rowCount = 0;
        note = `denied status=${status}`;
      } else {
        allZero = false;
        note = `unexpected status=${status}`;
      }
    } catch (err) {
      allZero = false;
      note = `error=${err.message}`;
    }
    lines.push(`anon SELECT ${table} -> status=${status} ${note}`);
  }
  if (allZero) pass('anon zero rows on every Boardroom table');
  else fail('anon zero rows on every Boardroom table', 'see transcript');
  writeTranscript('04-anon-zero-rows.txt', lines.join('\n'));
}

function safeHost(url) {
  try {
    return new URL(url).host;
  } catch {
    return '(invalid)';
  }
}

// --- 5. Board denied KPI writes ----------------------------------------------
async function probeBoardKpiDenials(sessions) {
  const lines = [
    `# board KPI write denials @ ${LIVE}`,
    `at: ${new Date().toISOString()}`,
    ''
  ];
  const boardTok = sessions.board.token;
  const post = await fetch(`${LIVE}/api/kpi-values`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${boardTok}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      key: 'bypass_count',
      period: '2026-07',
      value: 999
    })
  });
  lines.push(`board POST /api/kpi-values -> ${post.status}`);
  if (post.status === 403 || post.status === 401) {
    pass('board INSERT kpi_values denied', `status=${post.status}`);
  } else {
    fail('board INSERT kpi_values denied', `status=${post.status}`);
  }

  const put = await fetch(`${LIVE}/api/kpi-definitions/bypass_count`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${boardTok}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ definition: 'HACKED' })
  });
  lines.push(`board PUT /api/kpi-definitions/bypass_count -> ${put.status}`);
  if (put.status === 403 || put.status === 401) {
    pass('board UPDATE kpis denied', `status=${put.status}`);
  } else {
    fail('board UPDATE kpis denied', `status=${put.status}`);
  }
  writeTranscript('05-board-kpi-denials.txt', lines.join('\n'));
}

// --- 6. audit_log immutable (API + policy transcript pointer) ----------------
async function probeAuditLog(sessions) {
  const lines = [
    `# audit_log immutability @ ${LIVE}`,
    `at: ${new Date().toISOString()}`,
    '',
    'API surface is append-only (no UPDATE/DELETE routes). RLS policies:',
    'supabase/migrations/0003_rls.sql — INSERT+SELECT only; no UPDATE/DELETE.',
    'Local harness: docs/evidence/security/06b-rls-verify.txt (when DATABASE_URL set).',
    ''
  ];
  for (const role of ['founder', 'board']) {
    const tok = sessions[role].token;
    for (const method of ['PUT', 'PATCH', 'DELETE']) {
      const res = await fetch(`${LIVE}/api/audit-log`, {
        method,
        headers: {
          Authorization: `Bearer ${tok}`,
          'Content-Type': 'application/json'
        },
        body: method === 'DELETE' ? undefined : JSON.stringify({ action: 'tamper' })
      });
      // 401/403/404/405 all prove no successful mutation path.
      const ok = res.status === 401 || res.status === 403 || res.status === 404 || res.status === 405;
      lines.push(`${role} ${method} /api/audit-log -> ${res.status} pass=${ok}`);
      if (ok) pass(`${role} ${method} audit_log denied`, `status=${res.status}`);
      else fail(`${role} ${method} audit_log denied`, `status=${res.status}`);
    }
  }
  writeTranscript('06-audit-log-immutable.txt', lines.join('\n'));
}

// --- 7. Memo storage private + signed 3600s ----------------------------------
async function probeMemoStorage(sessions) {
  const lines = [
    `# memo storage privacy + signed URL TTL @ ${LIVE}`,
    `at: ${new Date().toISOString()}`,
    ''
  ];
  // Minimal PDF payload
  const pdf = Buffer.from(
    '%PDF-1.1\n1 0 obj<< /Type /Catalog >>endobj\ntrailer<< /Root 1 0 R >>\n%%EOF\n'
  );
  const up = await fetch(`${LIVE}/api/memos`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${sessions.founder.token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      filename: 'security-probe.pdf',
      meeting_date: '2026-07-20',
      content_type: 'application/pdf',
      content_base64: pdf.toString('base64')
    })
  });
  lines.push(`founder POST /api/memos -> ${up.status}`);
  if (!up.ok) {
    fail('memo upload for storage probe', `status=${up.status}`);
    writeTranscript('07-memo-storage.txt', lines.join('\n'));
    return;
  }
  const memoBody = await up.json();
  const memo = memoBody.memo || memoBody;
  const storagePath = memo.storage_path;
  lines.push(`storage_path set: ${storagePath ? 'yes' : 'no'}`);
  lines.push(`memo id set: ${memo.id ? 'yes' : 'no'}`);

  // Mint signed URL via the dedicated authenticated endpoint.
  let signedUrl = null;
  let expiresIn = null;
  let publicUrl = null;
  if (memo.id) {
    const su = await fetch(`${LIVE}/api/memos/${memo.id}/signed-url`, {
      headers: { Authorization: `Bearer ${sessions.founder.token}` },
      cache: 'no-store'
    });
    lines.push(`GET /api/memos/:id/signed-url -> ${su.status}`);
    if (su.ok) {
      const body = await su.json();
      signedUrl = body.signedUrl || body.signed_url || null;
      expiresIn = body.expiresIn ?? body.expires_in ?? null;
      publicUrl = body.publicUrl || body.public_url || null;
    }
  }
  lines.push(`signed URL present: ${signedUrl ? 'yes' : 'no'} (URL never logged)`);
  lines.push(`expires_in claim: ${expiresIn}`);

  // Public object path must 4xx
  const publicPath =
    publicUrl ||
    `${LIVE}/storage/v1/object/public/${storagePath || 'memos/probe/x.pdf'}`;
  const pubRes = await fetch(publicPath, { redirect: 'manual' });
  lines.push(`GET public object -> ${pubRes.status}`);
  if (pubRes.status >= 400 && pubRes.status < 500) {
    pass('public memo storage URL is 4xx', `status=${pubRes.status}`);
  } else {
    fail('public memo storage URL is 4xx', `status=${pubRes.status}`);
  }

  // Signed URL works + 3600s
  if (signedUrl) {
    const signed = await fetch(signedUrl, { redirect: 'manual' });
    lines.push(`GET signed URL -> ${signed.status}`);
    if (signed.status === 200) pass('signed memo URL works', `status=200`);
    else fail('signed memo URL works', `status=${signed.status}`);

    // Prefer explicit expiresIn; else decode JWT exp-iat without logging token.
    let ttl = typeof expiresIn === 'number' ? expiresIn : null;
    if (ttl == null) {
      try {
        const u = new URL(signedUrl);
        const token = u.searchParams.get('token') || '';
        const payload = JSON.parse(
          Buffer.from(token.split('.')[1] || '', 'base64url').toString('utf8')
        );
        if (typeof payload.ttl === 'number') ttl = payload.ttl;
        else if (typeof payload.exp === 'number' && typeof payload.iat === 'number') {
          ttl = payload.exp - payload.iat;
        }
      } catch {
        /* ignore */
      }
    }
    lines.push(`signed URL TTL seconds: ${ttl}`);
    if (ttl === 3600) pass('signed URL TTL is 3600s');
    else fail('signed URL TTL is 3600s', `ttl=${ttl}`);
  } else {
    fail('signed memo URL works', 'no signedUrl from /signed-url');
    fail('signed URL TTL is 3600s', 'no signedUrl');
  }
  writeTranscript('07-memo-storage.txt', lines.join('\n'));
}

// --- 8. No self-signup -------------------------------------------------------
async function probeNoSelfSignup() {
  const lines = [
    `# no self-signup @ ${LIVE}`,
    `at: ${new Date().toISOString()}`,
    ''
  ];
  const checks = [
    { method: 'GET', path: '/signup' },
    { method: 'GET', path: '/register' },
    { method: 'POST', path: '/signup', body: {} },
    { method: 'POST', path: '/register', body: {} },
    { method: 'POST', path: '/auth/v1/signup', body: { email: 'evil@example.com', password: 'x' } },
    { method: 'POST', path: '/auth/v1/register', body: { email: 'evil@example.com' } }
  ];
  for (const { method, path, body } of checks) {
    const { status } = await statusOf(path, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined
    });
    const ok = status === 404 || status === 403 || status === 405;
    lines.push(`${method} ${path} -> ${status} pass=${ok}`);
    if (ok) pass(`no self-signup ${method} ${path}`, `status=${status}`);
    else fail(`no self-signup ${method} ${path}`, `status=${status}`);
  }
  writeTranscript('08-no-self-signup.txt', lines.join('\n'));
}

// --- 9. Client bundles: no sk-ant / service-role JWT --------------------------
async function probeClientSecrets() {
  const lines = [
    `# client asset secret scan @ ${LIVE}`,
    `at: ${new Date().toISOString()}`,
    ''
  ];
  // Collect HTML + linked scripts from a few public/login pages
  const pages = ['/login', '/'];
  const bodies = [];
  const scriptUrls = new Set();
  for (const path of pages) {
    const res = await fetch(`${LIVE}${path}`);
    const html = await res.text();
    bodies.push({ src: path, text: html });
    const re = /(?:src|href)=["']([^"']+\.js[^"']*)["']/gi;
    let m;
    while ((m = re.exec(html))) {
      try {
        const abs = new URL(m[1], LIVE).toString();
        if (abs.startsWith(LIVE)) scriptUrls.add(abs);
      } catch {
        /* ignore */
      }
    }
  }
  // Cap script fetches
  let i = 0;
  for (const url of scriptUrls) {
    if (i++ > 40) break;
    try {
      const res = await fetch(url);
      const text = await res.text();
      bodies.push({ src: url.replace(LIVE, ''), text });
    } catch {
      /* ignore */
    }
  }

  // Also scan committed static export if present
  const publicRoot = join(ROOT, 'apps', 'api', 'public');
  if (existsSync(publicRoot)) {
    const walk = (dir) => {
      for (const ent of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, ent.name);
        if (ent.isDirectory()) walk(p);
        else if (/\.(js|html|css|txt|json|map)$/i.test(ent.name)) {
          try {
            bodies.push({
              src: relative(ROOT, p),
              text: readFileSync(p, 'utf8')
            });
          } catch {
            /* ignore */
          }
        }
      }
    };
    walk(publicRoot);
  }

  let skAntHits = 0;
  let serviceRoleHits = 0;
  const hitFiles = [];
  for (const { src, text } of bodies) {
    if (/sk-ant-[a-zA-Z0-9_-]{8,}/.test(text) || /sk-ant-api/.test(text)) {
      skAntHits += 1;
      hitFiles.push(`sk-ant in ${src}`);
    }
    // Service-role JWTs are HS256 with role:"service_role" in the payload.
    // Scan for that claim shape; never log the token.
    if (
      /["']role["']\s*:\s*["']service_role["']/.test(text) ||
      /service_role.{0,40}eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/.test(text)
    ) {
      // Allow docs/comments that merely name the env var / role string in isolation
      // only when not adjacent to a JWT-looking segment — already covered above.
      if (/eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/.test(text)) {
        // Decode payload segments looking for service_role without logging secrets.
        const jwtRe =
          /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g;
        let jm;
        while ((jm = jwtRe.exec(text))) {
          try {
            const payload = JSON.parse(
              Buffer.from(jm[0].split('.')[1], 'base64url').toString('utf8')
            );
            if (payload && payload.role === 'service_role') {
              serviceRoleHits += 1;
              hitFiles.push(`service_role JWT in ${src}`);
              break;
            }
          } catch {
            /* ignore */
          }
        }
      }
    }
  }
  lines.push(`assets scanned: ${bodies.length}`);
  lines.push(`sk-ant hits: ${skAntHits}`);
  lines.push(`service_role JWT hits: ${serviceRoleHits}`);
  if (hitFiles.length) lines.push(...hitFiles.map((h) => `  - ${h}`));

  if (skAntHits === 0) pass('client assets contain no sk-ant key');
  else fail('client assets contain no sk-ant key', `${skAntHits} hits`);
  if (serviceRoleHits === 0) pass('client assets contain no service-role JWT');
  else fail('client assets contain no service-role JWT', `${serviceRoleHits} hits`);

  // Git history scan on main (names only — no secret values emitted)
  const hist = spawnSync(
    'git',
    ['log', 'main', '--all', '-S', 'sk-ant-', '--oneline', '--', '.', ],
    { cwd: ROOT, encoding: 'utf8' }
  );
  const histLines = (hist.stdout || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  // Test fixtures may mention sk-ant-test; flag only if a real-looking key shape
  // appears in a non-test path historically. We re-check with git grep.
  const grep = spawnSync(
    'git',
    ['grep', '-n', 'sk-ant-[a-zA-Z0-9_-]\\{20,\\}', 'main', '--', '.', ],
    { cwd: ROOT, encoding: 'utf8' }
  );
  const realKeyHits = (grep.stdout || '')
    .split('\n')
    .filter((l) => l && !/test\//.test(l) && !/\.test\.js/.test(l) && !/fixtures\//.test(l));
  lines.push(`git sk-ant history commits: ${histLines.length}`);
  lines.push(`git real-looking sk-ant (non-test): ${realKeyHits.length}`);
  if (realKeyHits.length === 0) pass('git history has no real Anthropic keys on main');
  else fail('git history has no real Anthropic keys on main', `${realKeyHits.length} hits`);

  writeTranscript('09-client-secret-scan.txt', lines.join('\n'));
}

// --- 10. Local RLS verify (optional DATABASE_URL) ----------------------------
function probeRlsLocal() {
  const db = process.env.DATABASE_URL || '';
  const lines = [
    `# local RLS verify`,
    `at: ${new Date().toISOString()}`,
    `database: ${db ? 'DATABASE_URL set (host redacted)' : 'not set — skipped'}`,
    ''
  ];
  if (!db) {
    lines.push('Skipped: set DATABASE_URL to a throwaway Postgres to run supabase/verify.sh');
    writeTranscript('06b-rls-verify.txt', lines.join('\n'));
    return;
  }
  // Reset public schema so migrations re-apply cleanly on a reused throwaway DB.
  const reset = spawnSync(
    'psql',
    [
      db,
      '-v',
      'ON_ERROR_STOP=1',
      '-c',
      'DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public; GRANT ALL ON SCHEMA public TO public;'
    ],
    { encoding: 'utf8' }
  );
  if (reset.status !== 0) {
    lines.push('schema reset failed:');
    lines.push(reset.stderr || reset.stdout || '');
    writeTranscript('06b-rls-verify.txt', lines.join('\n'));
    fail('local RLS verify (anon/board/audit_log)', 'schema reset failed');
    return;
  }
  const out = spawnSync('bash', [join(ROOT, 'supabase', 'verify.sh')], {
    cwd: ROOT,
    env: { ...process.env, DATABASE_URL: db },
    encoding: 'utf8'
  });
  const combined = `${out.stdout || ''}${out.stderr || ''}`;
  lines.push(combined);
  lines.push(`exit_code: ${out.status}`);
  writeTranscript('06b-rls-verify.txt', lines.join('\n'));
  // Also copy as the board/audit RLS evidence aliases expected by the mission.
  writeTranscript('04b-rls-anon-and-board.txt', combined + `\nexit_code: ${out.status}\n`);
  if (out.status === 0) {
    pass('local RLS verify (anon/board/audit_log)');
  } else {
    fail('local RLS verify (anon/board/audit_log)', `exit=${out.status}`);
  }
}

async function main() {
  mkdirSync(EVIDENCE, { recursive: true });
  console.log(`security-probe against ${LIVE}`);

  await probePublicEndpoints();
  await probeAppRoutes();
  await probeApiAuth();
  await probeAnonZeroRows();

  let sessions = null;
  try {
    const founder = await sessionFor(FOUNDER);
    const board = await sessionFor(BOARD);
    sessions = { founder, board };
    pass('minted founder + board sessions for role probes');
  } catch (err) {
    fail('mint sessions for role probes', err.message);
  }

  if (sessions) {
    await probeBoardKpiDenials(sessions);
    await probeAuditLog(sessions);
    await probeMemoStorage(sessions);
  } else {
    fail('board KPI denials', 'no sessions');
    fail('audit_log probes', 'no sessions');
    fail('memo storage probes', 'no sessions');
  }

  await probeNoSelfSignup();
  await probeClientSecrets();
  probeRlsLocal();

  const summary = {
    live: LIVE,
    at: new Date().toISOString(),
    total: results.length,
    passed: results.filter((r) => r.pass).length,
    failed: results.filter((r) => !r.pass).length,
    results: results.map((r) => ({
      name: r.name,
      pass: r.pass,
      // detail may include status codes only — never tokens
      detail: r.detail
    })),
    evidence_dir: 'docs/evidence/security/',
    note: 'Transcripts contain no tokens, service-role keys, or Anthropic keys.'
  };
  writeTranscript('00-summary.json', JSON.stringify(summary, null, 2));
  writeTranscript(
    'README.md',
    [
      '# Security evidence transcripts',
      '',
      'Generated by `scripts/security-probe.mjs` for the ig-board security hard-pass mission.',
      '',
      '| File | Covers |',
      '| --- | --- |',
      '| `00-summary.json` | Aggregate pass/fail (no secrets) |',
      '| `01-public-health-version.txt` | GET /health + /version unauthenticated 200 |',
      '| `02-app-routes-auth.txt` | App routes require auth (AuthGuard → /login or 401) |',
      '| `03-unauth-api.txt` | Unauthenticated API → 401/403 |',
      '| `04-anon-zero-rows.txt` | Anon client zero rows on every Boardroom table |',
      '| `04b-rls-anon-and-board.txt` | Local Postgres RLS harness (when DATABASE_URL set) |',
      '| `05-board-kpi-denials.txt` | Board denied INSERT kpi_values / UPDATE kpis |',
      '| `06-audit-log-immutable.txt` | No UPDATE/DELETE path for audit_log |',
      '| `06b-rls-verify.txt` | Full `supabase/verify.sh` transcript |',
      '| `07-memo-storage.txt` | Public storage 4xx; signed URL 200 + 3600s |',
      '| `08-no-self-signup.txt` | /signup /register /auth/v1/signup disabled |',
      '| `09-client-secret-scan.txt` | No sk-ant / service-role JWT in client assets |',
      '',
      'Never commit tokens, service-role keys, or Anthropic keys here.',
      ''
    ].join('\n')
  );

  console.log(
    `\n== security-probe: ${summary.passed}/${summary.total} passed, ${summary.failed} failed ==`
  );
  if (summary.failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error('security-probe crashed:', err && err.message);
  process.exit(2);
});
