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
import { resolveVersion } from './version.js';
import { authHook } from './auth.js';

const app = Fastify({
  logger: true,
  // Railway terminates TLS and forwards; trust the proxy for correct client IPs.
  trustProxy: true
});

// Enforce the auth boundary on every request; /health and /version bypass it.
app.addHook('onRequest', authHook);

app.get('/', async () => ({
  service: 'ig-board-api',
  ok: true,
  endpoints: ['/health', '/version', '/me']
}));

app.get('/health', async (_req, reply) => {
  reply.code(200).send({ status: 'ok', uptime: process.uptime() });
});

app.get('/version', async (_req, reply) => {
  reply.code(200).send(resolveVersion());
});

// Authenticated identity: the JWT was already verified by the auth hook.
app.get('/me', async (req, reply) => {
  const auth = req.auth || {};
  reply.code(200).send({ id: auth.userId ?? null, role: auth.role ?? null });
});

const port = Number(process.env.PORT) || 8080;
const host = process.env.HOST || '0.0.0.0';

app
  .listen({ port, host })
  .then((address) => {
    app.log.info(`ig-board-api listening on ${address}`);
  })
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });

// Graceful shutdown so Railway redeploys don't hang on the old instance.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    app.close().then(() => process.exit(0));
  });
}
