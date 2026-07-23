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
import { pathToFileURL } from 'node:url';
import { resolveVersion } from './version.js';
import { authHook, jwtSecret } from './auth.js';
import { isAdminConfigured } from './supabaseAdmin.js';

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

  // Enforce the auth boundary on every request; /health and /version bypass it.
  app.addHook('onRequest', authHook);

  app.get('/', async () => ({
    service: 'ig-board-api',
    ok: true,
    endpoints: ['/health', '/version', '/ready', '/me']
  }));

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
