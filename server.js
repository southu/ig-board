// server.js — Boardroom API shell.
//
// Primary job for the deploy pipeline: serve GET /version with the deployed git
// SHA so the health check passes. On boot it also best-effort applies the
// schema migrations and the idempotent seed against DATABASE_URL (if present),
// but a missing/unreachable database never prevents the server from serving
// /version.

const http = require('http');
const { execFileSync } = require('child_process');
const path = require('path');

const PORT = process.env.PORT || 8080;
const HOST = '0.0.0.0';

function gitSha() {
  const fromEnv = process.env.RAILWAY_GIT_COMMIT_SHA ||
    process.env.GIT_SHA || process.env.SOURCE_VERSION;
  if (fromEnv) return fromEnv.trim();
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: __dirname, stdio: ['ignore', 'pipe', 'ignore'],
    }).toString().trim();
  } catch {
    return 'unknown';
  }
}

const SHA = gitSha();
const STARTED_AT = new Date().toISOString();

// Best-effort schema apply + seed. Fire-and-forget; never blocks serving.
async function bootstrapDatabase() {
  if (!process.env.DATABASE_URL) {
    console.log('[boot] DATABASE_URL not set — skipping migrate/seed');
    return;
  }
  const cli = path.join(__dirname, 'db', 'cli.js');
  for (const step of ['migrate', 'seed']) {
    try {
      console.log(`[boot] db ${step} ...`);
      execFileSync(process.execPath, [cli, step], { stdio: 'inherit' });
      console.log(`[boot] db ${step} ok`);
    } catch (err) {
      console.error(`[boot] db ${step} failed: ${err.message}`);
      break;
    }
  }
}

const server = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];

  if (url === '/version') {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(SHA);
    return;
  }

  if (url === '/health' || url === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ status: 'ok', sha: SHA, started_at: STARTED_AT }));
    return;
  }

  if (url === '/') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      service: 'ig-board',
      description: 'Boardroom BI platform for The Image Group',
      version: SHA,
      endpoints: ['/version', '/health'],
    }));
    return;
  }

  res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ status: 'error', code: 404, message: 'not found' }));
});

server.listen(PORT, HOST, () => {
  console.log(`ig-board listening on ${HOST}:${PORT} (sha ${SHA})`);
  bootstrapDatabase().catch((e) => console.error('[boot] error', e));
});
