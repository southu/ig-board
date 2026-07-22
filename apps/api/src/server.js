// Boardroom API — minimal Fastify service for the ig-board foundation mission.
//
// Public, unauthenticated endpoints only for this mission:
//   GET /health   -> 200 liveness probe
//   GET /version  -> 200 deployed git SHA (matches origin/main HEAD on Railway)
//
// Product surface (auth, data access) is intentionally deferred to later
// missions; this service only proves the deploy + version wiring.
import Fastify from 'fastify';
import { resolveVersion } from './version.js';

const app = Fastify({
  logger: true,
  // Railway terminates TLS and forwards; trust the proxy for correct client IPs.
  trustProxy: true
});

app.get('/', async () => ({
  service: 'ig-board-api',
  ok: true,
  endpoints: ['/health', '/version']
}));

app.get('/health', async (_req, reply) => {
  reply.code(200).send({ status: 'ok', uptime: process.uptime() });
});

app.get('/version', async (_req, reply) => {
  reply.code(200).send(resolveVersion());
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
