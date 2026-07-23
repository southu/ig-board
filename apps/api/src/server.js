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
import { isAdminConfigured } from './supabaseAdmin.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// The Next.js static export (apps/web/out) is served from this same service so a
// single live_url satisfies every check. Overridable for tests / alt layouts.
function resolveWebRoot() {
  const fromEnv = (process.env.WEB_ROOT || '').trim();
  if (fromEnv) return fromEnv;
  return join(__dirname, '..', '..', 'web', 'out');
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
  app.get('/ready', async (_req, reply) => {
    const authSecret = jwtSecret().length > 0;
    const supabaseAdmin = isAdminConfigured();
    reply.code(200).send({
      service: 'ig-board-api',
      ready: authSecret && supabaseAdmin,
      checks: { authSecret, supabaseAdmin }
    });
  });

  // Authenticated identity: the JWT was already verified by the auth hook.
  app.get('/me', async (req, reply) => {
    const auth = req.auth || {};
    reply.code(200).send({ id: auth.userId ?? null, role: auth.role ?? null });
  });

  // Serve the Next.js static export (the web app) from this same service, so a
  // single live_url satisfies every check. Registered only when the export
  // exists (it is built by `npm run build` before deploy) so the API test suite
  // — which runs without building the web app — is unaffected.
  const webRoot = resolveWebRoot();
  if (existsSync(webRoot)) {
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
