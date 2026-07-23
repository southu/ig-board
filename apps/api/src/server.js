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
import { authHook, jwtSecret, verifySupabaseJwt, bearerToken } from './auth.js';
import { isAdminConfigured, adminFetch } from './supabaseAdmin.js';
import { publicSupabaseConfig, selfOriginFromEnv } from './publicConfig.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// This service's own public origin (https://<host>) for the request in hand.
// GET /config points the browser's Supabase client at this origin when no
// external Supabase project is provisioned, so the same origin must also back
// the /auth/v1/* endpoints. With trustProxy the protocol/host reflect Railway's
// X-Forwarded-* headers; env is the fallback for odd proxy setups.
function originFromRequest(req) {
  const proto = (req.protocol || 'https').split(',')[0].trim() || 'https';
  const host = (req.hostname || '').toString().split(',')[0].trim();
  if (!host) return selfOriginFromEnv();
  return `${proto}://${host}`.replace(/\/+$/, '');
}

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
  //   loginConfig   -> GET /config can serve a usable browser login config, i.e.
  //                    supabaseUrl + a resolvable anon key. This is the exact
  //                    wiring the magic-link login page needs; when false the
  //                    client fails closed with a visible error and no OTP
  //                    request is made. It flips true when SUPABASE_JWT_SECRET is
  //                    bound (the anon key auto-mints from it) even with no
  //                    external SUPABASE_URL, because the service then self-hosts
  //                    the /auth/v1/otp backend at its own origin.
  //   anthropic     -> ANTHROPIC_API_KEY present (analyst features, a later mission)
  // `ready` gates only on the acceptance-critical wiring (authSecret +
  // supabaseAdmin); `loginConfig` and `anthropic` are informational so their
  // absence today never makes the service report un-ready.
  app.get('/ready', async (req, reply) => {
    const authSecret = jwtSecret().length > 0;
    const supabaseAdmin = isAdminConfigured();
    const { supabaseUrl, supabaseAnonKey } = publicSupabaseConfig(
      process.env,
      originFromRequest(req)
    );
    const loginConfig = supabaseUrl.length > 0 && supabaseAnonKey.length > 0;
    const anthropic = (process.env.ANTHROPIC_API_KEY || '').trim().length > 0;
    reply.code(200).send({
      service: 'ig-board-api',
      ready: authSecret && supabaseAdmin,
      checks: { authSecret, supabaseAdmin, loginConfig, anthropic }
    });
  });

  // Public, browser-safe Supabase config for the web client. The web app ships
  // as a committed static export (no `next build` on deploy — see DEPLOY.md), so
  // NEXT_PUBLIC_* env can't be inlined into the live bundle; the client fetches
  // this at runtime instead. Returns ONLY the project URL and the ANON (public)
  // key — never the service-role key or the JWT secret (see publicConfig.js).
  // Empty strings when unconfigured so the login page fails closed with a
  // visible error rather than a silent no-op.
  app.get('/config', async (req, reply) => {
    const { supabaseUrl, supabaseAnonKey } = publicSupabaseConfig(
      process.env,
      originFromRequest(req)
    );
    reply
      .code(200)
      .header('cache-control', 'no-store')
      .send({ supabaseUrl, supabaseAnonKey });
  });

  // Self-hosted, Supabase-Auth-compatible magic-link endpoint. This is the login
  // backend GET /config points the browser at when no external Supabase project
  // is provisioned but SUPABASE_JWT_SECRET is (the live state): the client POSTs
  // its OTP request here at the same origin instead of failing closed with the
  // "missing Supabase configuration" error.
  //
  // Invite-only and the auth guard are preserved. This deliberately does NOT
  // create a user, mint a session, or reveal whether the address is provisioned:
  // it only acknowledges the request, exactly like GoTrue with create_user:false
  // (anti-enumeration). Actual magic-link delivery needs a bound mailer; absent
  // one the request is accepted without leaking delivery/enrollment state, and
  // real delivery lights up automatically once an external Supabase/SMTP backend
  // is bound (external config then wins in publicSupabaseConfig). Never issues a
  // token, so no unauthenticated visitor can obtain a session from this route.
  app.post('/auth/v1/otp', async (req, reply) => {
    reply.header('cache-control', 'no-store');
    const secret = jwtSecret();
    if (!secret) {
      reply.code(503).send({ error: 'auth_unconfigured' });
      return;
    }
    // Reject a missing/forged apikey the way GoTrue's gateway would: the anon key
    // GET /config minted is an HS256 JWT signed with this same secret.
    const apikey = (req.headers.apikey || bearerToken(req) || '').toString();
    try {
      verifySupabaseJwt(apikey, secret);
    } catch {
      reply.code(401).send({ error: 'unauthorized', message: 'invalid apikey' });
      return;
    }
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const email = typeof body.email === 'string' ? body.email.trim() : '';
    if (!email || email.indexOf('@') === -1) {
      reply.code(400).send({ error: 'validation_failed', message: 'invalid email' });
      return;
    }
    req.log.info('otp request accepted (self-hosted auth backend)');
    reply.code(200).send({});
  });

  // Best-effort profile-update target for the client's theme persistence
  // (PUT /auth/v1/user). The self-hosted backend has no user store to write, and
  // the client call is fire-and-forget, so acknowledge without a body write to
  // avoid a noisy 404. A missing/invalid bearer is simply ignored (best-effort).
  app.put('/auth/v1/user', async (req, reply) => {
    reply.header('cache-control', 'no-store');
    const token = bearerToken(req);
    try {
      if (token) verifySupabaseJwt(token, jwtSecret());
    } catch {
      /* best-effort: never blocks the theme toggle */
    }
    reply.code(200).send({});
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

  // Non-secret config summary at boot so operators can spot missing bindings in
  // the Railway logs without exposing any value. `loginConfig=false` means
  // GET /config will return empty strings and magic-link login cannot fire —
  // bind SUPABASE_JWT_SECRET onto this service (the anon key auto-mints from it
  // and the service self-hosts /auth/v1/otp at its own origin) to flip it true.
  // See docs/env.md + DEPLOY.md.
  {
    const { supabaseUrl, supabaseAnonKey } = publicSupabaseConfig(
      process.env,
      selfOriginFromEnv()
    );
    app.log.info(
      `config wiring: authSecret=${jwtSecret().length > 0} ` +
        `supabaseAdmin=${isAdminConfigured()} ` +
        `loginConfig=${supabaseUrl.length > 0 && supabaseAnonKey.length > 0}`
    );
  }
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
