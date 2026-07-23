// Boardroom API — Fastify service for the ig-board mission.
//
// Public, unauthenticated endpoints:
//   GET /health   -> 200 liveness probe
//   GET /version  -> 200 deployed git SHA (matches origin/main HEAD on Railway)
//
// Every other route requires a valid Supabase JWT (Authorization: Bearer <token>);
// missing/invalid tokens get a 401. See src/auth.js for the verification details.
//   GET /me       -> 200 { id, role } for the authenticated user (role founder|board)
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { resolveVersion } from './version.js';
import { authHook, jwtSecret } from './auth.js';
import { isAdminConfigured, adminFetch } from './supabaseAdmin.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// The Next.js static export (apps/web/out) is served from this same service so a
// single live_url satisfies every check. Overridable for tests / alt layouts.
//
// The build emits to apps/web/out, but the runtime working directory and image
// layout can differ by builder (NIXPACKS build root, a flattened image, etc.).
// Rather than assume one relative path, probe the plausible locations and pick
// the first that actually contains the export (index.html present). WEB_ROOT
// still wins when set. Returning the first candidate as a fallback keeps the
// old behavior when nothing is found (server logs the resolution at boot).
function webRootCandidates() {
  const cwd = process.cwd();
  return [
    join(__dirname, '..', '..', 'web', 'out'), // repo layout: apps/api/src -> apps/web/out
    join(cwd, 'apps', 'web', 'out'), // run from repo root
    join(cwd, 'web', 'out'), // run from apps/
    join(__dirname, '..', 'public') // co-located export copied under the api
  ];
}

function resolveWebRoot() {
  const fromEnv = (process.env.WEB_ROOT || '').trim();
  if (fromEnv) return fromEnv;
  const candidates = webRootCandidates();
  for (const dir of candidates) {
    if (existsSync(join(dir, 'index.html'))) return dir;
  }
  return candidates[0];
}

// Build the fully-wired Fastify app (auth boundary + routes). Exported as a
// factory so tests can exercise the real HTTP surface via app.inject() without
// binding a port. Pass Fastify options through for test-time overrides.
export function buildApp(opts = {}) {
  const app = Fastify({
    logger: true,
    // Railway terminates TLS and forwards; trust the proxy for correct client IPs.
    trustProxy: true,
    ...opts
  });

  // Enforce the auth boundary on every request; the public probes and the
  // static web app bypass it (see auth.js — only /me and /api/* are protected).
  app.addHook('onRequest', authHook);

  app.get('/health', async (_req, reply) => {
    reply.code(200).send({ status: 'ok', uptime: process.uptime() });
  });

  app.get('/version', async (_req, reply) => {
    reply.code(200).send(resolveVersion());
  });

  // Non-secret readiness probe: reports whether the server-side env (sourced from
  // the vault onto the Railway service) is bound, as booleans ONLY — never any
  // value. Lets the live tester / operators confirm the wiring without secrets:
  //   authSecret    -> SUPABASE_JWT_SECRET present, so /me can authenticate
  //   supabaseAdmin -> SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY present (admin ops)
  //   anthropic     -> ANTHROPIC_API_KEY present (analyst features, a later mission)
  // `ready` gates only on the acceptance-critical wiring (authSecret +
  // supabaseAdmin); `anthropic` is informational so its absence today never makes
  // the service report un-ready.
  app.get('/ready', async (_req, reply) => {
    const authSecret = jwtSecret().length > 0;
    const supabaseAdmin = isAdminConfigured();
    const anthropic = (process.env.ANTHROPIC_API_KEY || '').trim().length > 0;
    reply.code(200).send({
      service: 'ig-board-api',
      ready: authSecret && supabaseAdmin,
      checks: { authSecret, supabaseAdmin, anthropic }
    });
  });

  // Authenticated identity: the JWT was already verified by the auth hook.
  app.get('/me', async (req, reply) => {
    const auth = req.auth || {};
    reply.code(200).send({ id: auth.userId ?? null, role: auth.role ?? null });
  });

  // Scorecard KPI time-series for the authenticated web client. Under /api/ so
  // the auth hook has already required a valid Supabase JWT (founder or board —
  // both may read this data under RLS). The server reads it with the service
  // role so the browser never needs the anon key: a single same-origin call
  // returns { values: { <kpiKey>: [{ period, value }, ...] } }, ordered by
  // period ascending. The RAG status itself is computed client-side from these
  // values vs. the KPI thresholds/direction (the mission's source of truth).
  //
  // Fail SOFT: any missing config or upstream error resolves to an empty map so
  // the UI renders its deliberate gray no-data state rather than erroring. No
  // secret is ever returned — only the (non-sensitive) observed values.
  app.get('/api/kpi-values', async (req, reply) => {
    if (!isAdminConfigured()) {
      reply.code(200).send({ values: {} });
      return;
    }
    try {
      const [kpisRes, valuesRes] = await Promise.all([
        adminFetch('/rest/v1/kpis?select=id,key'),
        adminFetch(
          '/rest/v1/kpi_values?select=kpi_id,period,value&order=period.asc'
        )
      ]);
      if (!kpisRes.ok || !valuesRes.ok) {
        reply.code(200).send({ values: {} });
        return;
      }
      const kpis = await kpisRes.json();
      const values = await valuesRes.json();
      const idToKey = new Map(kpis.map((k) => [k.id, k.key]));
      const byKey = {};
      for (const v of values) {
        const key = idToKey.get(v.kpi_id);
        if (!key) continue;
        (byKey[key] ||= []).push({ period: v.period, value: v.value });
      }
      reply.code(200).send({ values: byKey });
    } catch (err) {
      req.log.error({ err: err && err.message }, 'kpi-values fetch failed');
      reply.code(200).send({ values: {} });
    }
  });

  // Serve the Next.js static export (the web app) from this same service, so a
  // single live_url satisfies every check. Registered only when the export
  // exists (it is built by `npm run build` before deploy) so the API test suite
  // — which runs without building the web app — is unaffected.
  const webRoot = resolveWebRoot();
  const webRootServed = existsSync(join(webRoot, 'index.html'));
  app.log.info(
    `web export: ${webRootServed ? 'serving' : 'NOT FOUND'} at ${webRoot}`
  );
  if (webRootServed) {
    app.register(fastifyStatic, {
      root: webRoot,
      index: ['index.html'],
      // Long-lived, content-hashed assets can be cached hard; HTML is revalidated.
      cacheControl: false
    });

    // Static export emits clean-URL pages as `<route>.html` (e.g. login.html).
    // A bare `/login` request misses the file lookup and lands here; map it to
    // the matching HTML page, else fall back to the 404 page (or a 404 JSON).
    app.setNotFoundHandler((req, reply) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        reply.code(404).send({ error: 'not_found' });
        return;
      }
      const rawPath = (req.url.split('?')[0] || '/').replace(/\/+$/, '');
      const slug = rawPath === '' ? 'index' : rawPath.replace(/^\/+/, '');
      for (const candidate of [`${slug}.html`, `${slug}/index.html`]) {
        if (existsSync(join(webRoot, candidate))) {
          reply.type('text/html; charset=utf-8');
          return reply.sendFile(candidate);
        }
      }
      if (existsSync(join(webRoot, '404.html'))) {
        reply.code(404).type('text/html; charset=utf-8');
        return reply.sendFile('404.html');
      }
      reply.code(404).send({ error: 'not_found' });
    });
  } else {
    // No web export present (e.g. the API test run): keep a JSON service index
    // at / so the root is still a valid 200 for API-only smoke checks.
    app.get('/', async () => ({
      service: 'ig-board-api',
      ok: true,
      endpoints: ['/health', '/version', '/ready', '/me']
    }));
  }

  return app;
}

// Boot the server when run directly (e.g. `node apps/api/src/server.js` on
// Railway). Guarded so importing this module in tests does not bind a port.
async function start() {
  const app = buildApp();
  const port = Number(process.env.PORT) || 8080;
  const host = process.env.HOST || '0.0.0.0';

  try {
    const address = await app.listen({ port, host });
    app.log.info(`ig-board-api listening on ${address}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }

  // Graceful shutdown so Railway redeploys don't hang on the old instance.
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      app.close().then(() => process.exit(0));
    });
  }
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  start();
}
