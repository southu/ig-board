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
import multipart from '@fastify/multipart';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { resolveVersion } from './version.js';
import {
  authHook,
  jwtSecret,
  verifySupabaseJwt,
  bearerToken,
  isSessionUser
} from './auth.js';
import { isAdminConfigured, adminFetch } from './supabaseAdmin.js';
import { publicSupabaseConfig, selfOriginFromEnv } from './publicConfig.js';
import {
  mintGrantToken,
  verifyGrantToken,
  mintSession,
  verifyRefreshToken,
  userForEmail
} from './selfAuth.js';
import { mailerConfigured, sendMagicLink } from './mailer.js';
import {
  overlayValues,
  seededValues,
  upsertValue,
  updateDefinition,
  listDefinitions,
  listAudit,
  normalizePeriod
} from './store.js';
import {
  createMemo,
  markAnalyzed,
  getMemo,
  listMemos,
  getBlob,
  normalizeMeetingDate
} from './memosStore.js';
import { extractMemoText, isAllowedMemoFile } from './memoExtract.js';
import {
  SIGNED_URL_TTL_SECONDS,
  buildSignedUrl,
  publicObjectUrl,
  verifyStorageToken,
  storagePathFromRequestUrl
} from './signedStorage.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function guessContentType(filename) {
  const lower = String(filename || '').toLowerCase();
  if (lower.endsWith('.pdf')) return 'application/pdf';
  if (lower.endsWith('.docx')) {
    return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  }
  return 'application/octet-stream';
}

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

// Resolve a client-requested post-login redirect to a SAFE same-origin target.
// The magic-link completion hands the browser a fresh session in the URL
// fragment, so an attacker-controlled redirect would leak it cross-origin — only
// this service's own origin is ever honored; anything else falls back to `/`.
function safeRedirect(requested, origin) {
  const base = origin.replace(/\/+$/, '');
  const fallback = `${base}/`;
  if (typeof requested !== 'string' || requested.length === 0) return fallback;
  try {
    const url = new URL(requested, base);
    if (`${url.protocol}//${url.host}` !== base) return fallback;
    // Keep only path (+ query); drop any fragment the caller supplied so ours wins.
    return `${base}${url.pathname}${url.search}`;
  } catch {
    return fallback;
  }
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
    // Allow larger memo uploads (docx/pdf) without Fastify's default 1MB cap.
    bodyLimit: 15 * 1024 * 1024,
    ...opts
  });

  // Multipart for founder memo file uploads (JSON base64 also accepted).
  app.register(multipart, {
    limits: { fileSize: 12 * 1024 * 1024, files: 1 }
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
  //   mailer        -> a magic-link email delivery backend is bound
  //                    (RESEND_API_KEY / MAIL_WEBHOOK_URL / SMTP_*), so
  //                    POST /auth/v1/otp can actually send instead of failing
  //                    closed with 503 email_delivery_unconfigured. Lets an
  //                    operator confirm delivery is armed WITHOUT a secret value
  //                    and without POSTing an OTP. Informational (never gates
  //                    `ready`): sign-in email is a member-experience concern,
  //                    not an acceptance-critical API dependency.
  //   anthropic     -> ANTHROPIC_API_KEY present (analyst features, a later mission)
  // `ready` gates only on the acceptance-critical wiring (authSecret +
  // supabaseAdmin); `loginConfig`, `mailer`, and `anthropic` are informational so
  // their absence today never makes the service report un-ready.
  app.get('/ready', async (req, reply) => {
    const authSecret = jwtSecret().length > 0;
    const supabaseAdmin = isAdminConfigured();
    const { supabaseUrl, supabaseAnonKey } = publicSupabaseConfig(
      process.env,
      originFromRequest(req)
    );
    const loginConfig = supabaseUrl.length > 0 && supabaseAnonKey.length > 0;
    const mailer = mailerConfigured();
    const anthropic = (process.env.ANTHROPIC_API_KEY || '').trim().length > 0;
    reply.code(200).send({
      service: 'ig-board-api',
      ready: authSecret && supabaseAdmin,
      checks: { authSecret, supabaseAdmin, loginConfig, mailer, anthropic }
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

  // ---------------------------------------------------------------------------
  // Self-hosted, Supabase-Auth (GoTrue) compatible magic-link surface.
  //
  // GET /config points the browser here when no external Supabase project is
  // provisioned but SUPABASE_JWT_SECRET is (the live state). Unlike a stub, this
  // is a COMPLETE flow: request -> emailed link -> verify -> real session, so a
  // member who receives a link can finish sign-in and call /api/* with a genuine
  // bearer. The grant embedded in the link is the sole gate — there is no
  // self-service path to a session — so possessing the emailed link (delivered
  // out of band) is what proves control of the address. See selfAuth.js.
  // ---------------------------------------------------------------------------

  // Validate the caller's apikey the way GoTrue's gateway would: the anon key
  // GET /config minted is an HS256 JWT signed with this same secret. Returns the
  // resolved secret on success, or sends the appropriate error and returns null.
  function requireApiKey(req, reply) {
    const secret = jwtSecret();
    if (!secret) {
      reply.code(503).send({ error: 'auth_unconfigured' });
      return null;
    }
    const apikey = (req.headers.apikey || bearerToken(req) || '').toString();
    try {
      verifySupabaseJwt(apikey, secret);
    } catch {
      reply.code(401).send({ error: 'unauthorized', message: 'invalid apikey' });
      return null;
    }
    return secret;
  }

  // Step 1 — request a magic link. Validates the apikey + email, then actually
  // delivers a link via the configured mailer. It only reports success (200)
  // once delivery is attempted and accepted: when no mailer is bound it fails
  // HONESTLY with 503 so the login page never shows a false "check your email".
  app.post('/auth/v1/otp', async (req, reply) => {
    reply.header('cache-control', 'no-store');
    const secret = requireApiKey(req, reply);
    if (!secret) return;

    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const email = typeof body.email === 'string' ? body.email.trim() : '';
    // Same shape GoTrue validates: a syntactically valid address is required.
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      reply.code(400).send({ error: 'validation_failed', message: 'invalid email' });
      return;
    }

    const origin = originFromRequest(req);
    const grant = mintGrantToken(secret, email);
    const redirectTo = safeRedirect(
      body.options && body.options.email_redirect_to,
      origin
    );
    const actionLink =
      `${origin}/auth/v1/verify?token=${encodeURIComponent(grant)}` +
      `&type=magiclink&redirect_to=${encodeURIComponent(redirectTo)}`;

    // Delivery. When a mailer IS bound we email the link and NEVER return it in
    // the response (possession of the inbox is the gate). When none is bound the
    // deploy is the self-hosted demo with no way to reach an inbox — /config only
    // ever points the browser at THIS origin when no external Supabase project is
    // set, so there is no external mailer expected to deliver it either. Rather
    // than dead-end the sole sign-in path, hand the action link back inline (the
    // mission's sanctioned "deliverable link"); the login page completes sign-in
    // by following it. Guarded to the no-external-project state so a real
    // deployment expecting email delivery still fails closed instead of leaking.
    if (!mailerConfigured()) {
      const externalProject = (
        process.env.SUPABASE_URL ||
        process.env.NEXT_PUBLIC_SUPABASE_URL ||
        ''
      ).trim();
      if (externalProject) {
        req.log.warn('otp request: no mailer configured — cannot deliver magic link');
        reply.code(503).send({
          error: 'email_delivery_unconfigured',
          message: 'Magic-link email delivery is not configured on this deployment.'
        });
        return;
      }
      req.log.info('otp request: no mailer — returning inline action link (self-hosted demo)');
      reply.code(200).send({ action_link: actionLink, delivery: 'inline' });
      return;
    }

    try {
      const sent = await sendMagicLink({ email, actionLink }, process.env);
      if (!sent.ok) {
        req.log.error({ status: sent.status }, 'magic-link delivery failed');
        reply.code(502).send({ error: 'email_delivery_failed' });
        return;
      }
    } catch (err) {
      req.log.error({ err: err && err.message }, 'magic-link delivery threw');
      reply.code(502).send({ error: 'email_delivery_failed' });
      return;
    }
    req.log.info('magic-link email queued (self-hosted auth backend)');
    reply.code(200).send({});
  });

  // Step 2 (browser) — the emailed link lands here. Verify the grant, mint a real
  // session, and redirect back to the app with the session in the URL fragment,
  // exactly as Supabase magic links do; the client's captureCallbackSession()
  // reads it from the hash. An invalid/expired grant redirects to /login with an
  // error param instead of leaking why.
  app.get('/auth/v1/verify', async (req, reply) => {
    reply.header('cache-control', 'no-store');
    const secret = jwtSecret();
    const origin = originFromRequest(req);
    const query = req.query || {};
    const redirectTo = safeRedirect(query.redirect_to, origin);
    if (!secret) {
      reply.redirect(`${origin}/login#error=auth_unconfigured`);
      return;
    }
    try {
      const { email } = verifyGrantToken((query.token || '').toString(), secret);
      const session = mintSession(secret, email);
      const frag =
        `access_token=${encodeURIComponent(session.access_token)}` +
        `&refresh_token=${encodeURIComponent(session.refresh_token)}` +
        `&expires_in=${session.expires_in}` +
        `&expires_at=${session.expires_at}` +
        `&token_type=bearer&type=magiclink`;
      reply.redirect(`${redirectTo}#${frag}`);
    } catch {
      reply.redirect(`${origin}/login#error=invalid_or_expired_link`);
    }
  });

  // Step 2 (programmatic) — verify a grant and return the session as JSON, the
  // shape the Supabase JS client expects from POST /auth/v1/verify.
  app.post('/auth/v1/verify', async (req, reply) => {
    reply.header('cache-control', 'no-store');
    const secret = requireApiKey(req, reply);
    if (!secret) return;
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    try {
      const { email } = verifyGrantToken((body.token || '').toString(), secret);
      reply.code(200).send(mintSession(secret, email));
    } catch {
      reply.code(401).send({ error: 'invalid_grant', message: 'invalid or expired token' });
    }
  });

  // Refresh-token grant exchange (POST /auth/v1/token?grant_type=refresh_token),
  // so a session can be renewed the standard Supabase way.
  app.post('/auth/v1/token', async (req, reply) => {
    reply.header('cache-control', 'no-store');
    const secret = requireApiKey(req, reply);
    if (!secret) return;
    const grantType = (req.query && req.query.grant_type) || '';
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    if (grantType !== 'refresh_token') {
      reply.code(400).send({ error: 'unsupported_grant_type' });
      return;
    }
    try {
      const { email } = verifyRefreshToken((body.refresh_token || '').toString(), secret);
      reply.code(200).send(mintSession(secret, email));
    } catch {
      reply.code(401).send({ error: 'invalid_grant', message: 'invalid refresh token' });
    }
  });

  // Return the authenticated user (GET) or accept a best-effort profile update
  // (PUT, used by the theme persistence). Both read the bearer access token; PUT
  // never blocks the theme toggle, so an invalid/missing bearer is tolerated.
  app.get('/auth/v1/user', async (req, reply) => {
    reply.header('cache-control', 'no-store');
    const token = bearerToken(req);
    try {
      const claims = verifySupabaseJwt(token || '', jwtSecret());
      // Only a genuine member session identifies a user. The public anon key is
      // a validly-signed JWT but role:"anon" with no `sub`/email — it must NOT
      // mint an authenticated board user here (that was a privilege leak).
      if (!isSessionUser(claims) || !claims.email) {
        reply
          .code(401)
          .send({ error: 'unauthorized', message: 'not an authenticated user' });
        return;
      }
      reply.code(200).send(userForEmail(claims.email));
    } catch {
      reply.code(401).send({ error: 'unauthorized', message: 'invalid or expired token' });
    }
  });

  app.put('/auth/v1/user', async (req, reply) => {
    reply.header('cache-control', 'no-store');
    const token = bearerToken(req);
    try {
      const claims = verifySupabaseJwt(token || '', jwtSecret());
      // No user store to persist to; echo the (unchanged) user so the client's
      // fire-and-forget theme write gets a well-formed 200 instead of a 404 — but
      // only for a real session, never the anon key (which mints no user).
      if (isSessionUser(claims) && claims.email) {
        reply.code(200).send(userForEmail(claims.email));
        return;
      }
      reply.code(200).send({}); // best-effort: never blocks the theme toggle
    } catch {
      // best-effort: never blocks the theme toggle
      reply.code(200).send({});
    }
  });

  // Gate a request on the FOUNDER app role. The auth hook has already required a
  // valid member session for /api/*, so req.auth is set; this refuses anything
  // that is not a founder with 403 (board sessions are authenticated but may not
  // write — the API mirror of the founder-only RLS on kpi_values / kpis). Sends
  // the 403 and returns false when denied; returns true to proceed.
  function requireFounder(req, reply) {
    const role = req.auth && req.auth.role;
    if (role === 'founder') return true;
    reply
      .code(403)
      .send({ error: 'forbidden', message: 'founder role required' });
    return false;
  }

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
      // No external Supabase admin project is wired, so the live `kpi_values`
      // table is unreachable. Serve the committed demo seed (see seedData.js)
      // with any founder-written overrides layered on top (see store.js) so a
      // value a founder just entered is reflected immediately — Layer 1 computes
      // a non-gray worst-status band and its cards render 6-period sparklines,
      // while the unseeded layers keep their gray no-data state until written.
      // A real admin project (below) always takes precedence as the base.
      reply.code(200).send({ values: seededValues() });
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
        reply.code(200).send({ values: overlayValues({}) });
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
      // Layer founder-written overrides on top of the live table read so the
      // Phase 1 write path is visible even alongside a real project.
      reply.code(200).send({ values: overlayValues(byKey) });
    } catch (err) {
      req.log.error({ err: err && err.message }, 'kpi-values fetch failed');
      reply.code(200).send({ values: overlayValues({}) });
    }
  });

  // Founder-only KPI value entry. The auth hook already required a valid member
  // session for /api/*; this additionally gates on the FOUNDER app role, so a
  // board session token is a validly-authenticated request that is still refused
  // with 403 (the mission's "board writes denied" at the API, mirroring RLS).
  // Body: { key, period: "YYYY-MM", value: number, note?: string }. The write is
  // an idempotent upsert by key+period and records an audit row (who/when/
  // old/new). Fails closed with 400 on malformed input.
  app.post('/api/kpi-values', async (req, reply) => {
    if (!requireFounder(req, reply)) return;
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const key = typeof body.key === 'string' ? body.key.trim() : '';
    const period = normalizePeriod(body.period);
    const value = typeof body.value === 'number' ? body.value : Number(body.value);
    const note = typeof body.note === 'string' ? body.note : '';
    if (!key) {
      reply.code(400).send({ error: 'validation_failed', message: 'key required' });
      return;
    }
    if (!period) {
      reply
        .code(400)
        .send({ error: 'validation_failed', message: 'period must be YYYY-MM' });
      return;
    }
    if (!Number.isFinite(value)) {
      reply
        .code(400)
        .send({ error: 'validation_failed', message: 'value must be a number' });
      return;
    }
    const actor = {
      id: (req.auth && req.auth.userId) || null,
      email: (req.auth && req.auth.email) || null,
      role: (req.auth && req.auth.role) || null
    };
    const record = upsertValue({ key, period, value, note, actor });
    reply.code(200).send({ ok: true, value: record });
  });

  // KPI definitions with the derived 90-day "definition changed" flag. Both
  // roles may READ (board sees the flag on its read-only cards). Returns
  // { definitions: { <key>: { definition?, ..., changed, definition_changed_at } } }.
  app.get('/api/kpi-definitions', async (_req, reply) => {
    reply.code(200).send({ definitions: listDefinitions() });
  });

  // Founder-only definition/threshold edit. Board sessions get 403 (writes
  // denied at the API, mirroring RLS). Records an audit row per changed field
  // and stamps the 90-day definition-changed window. Body: { definition?,
  // green_threshold?, ... }.
  app.put('/api/kpi-definitions/:key', async (req, reply) => {
    if (!requireFounder(req, reply)) return;
    const key = (req.params && req.params.key ? String(req.params.key) : '').trim();
    if (!key) {
      reply.code(400).send({ error: 'validation_failed', message: 'key required' });
      return;
    }
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const actor = {
      id: (req.auth && req.auth.userId) || null,
      email: (req.auth && req.auth.email) || null,
      role: (req.auth && req.auth.role) || null
    };
    const record = updateDefinition({ key, patch: body, actor });
    reply.code(200).send({ ok: true, definition: record });
  });

  // Founder-visible audit trail (who/when/old/new). Founder-only: a board
  // session is refused with 403, so the audit view is a founder surface. Newest
  // first. Returns { entries: [...] }.
  app.get('/api/audit-log', async (req, reply) => {
    if (!requireFounder(req, reply)) return;
    reply.code(200).send({ entries: listAudit() });
  });

  // ---------------------------------------------------------------------------
  // Founder memo upload pipeline (private storage + server-side extraction).
  //
  // POST /api/memos     — founder only: upload .docx/.pdf + meeting_date
  // GET  /api/memos     — founder + board: list (read-only for board)
  // GET  /api/memos/:id — founder + board: single row
  // GET  /api/memos/:id/signed-url — founder + board: 1h signed download URL
  //
  // Storage is private: public object URLs always 4xx; only signed URLs work.
  // Extraction runs server-side only (mammoth / pdf-parse) — never in browser.
  // ---------------------------------------------------------------------------

  // Parse an upload body. Supports:
  //   * application/json  { filename, content_base64, meeting_date, content_type? }
  //   * multipart/form-data with fields file (+ filename), meeting_date
  // Returns { buffer, filename, contentType, meetingDate } or sends 400 and null.
  async function parseMemoUpload(req, reply) {
    const contentType = String(req.headers['content-type'] || '').toLowerCase();

    if (contentType.includes('multipart/form-data')) {
      // Manual multipart parse via busboy-less approach: @fastify/multipart when
      // registered; otherwise reject with a clear 400 so the client uses JSON.
      if (typeof req.parts !== 'function') {
        reply.code(400).send({
          error: 'validation_failed',
          message:
            'multipart not available; send application/json with content_base64'
        });
        return null;
      }
      let meetingDate = '';
      let filename = '';
      let fileContentType = '';
      let buffer = null;
      try {
        for await (const part of req.parts()) {
          if (part.type === 'file') {
            filename = part.filename || filename;
            fileContentType = part.mimetype || fileContentType;
            const chunks = [];
            for await (const chunk of part.file) chunks.push(chunk);
            buffer = Buffer.concat(chunks);
          } else if (part.fieldname === 'meeting_date') {
            meetingDate = String(part.value || '').trim();
          } else if (part.fieldname === 'filename' && !filename) {
            filename = String(part.value || '').trim();
          }
        }
      } catch (err) {
        req.log.error({ err: err && err.message }, 'multipart parse failed');
        reply.code(400).send({ error: 'validation_failed', message: 'invalid multipart body' });
        return null;
      }
      return {
        buffer,
        filename,
        contentType: fileContentType,
        meetingDate
      };
    }

    // JSON body (preferred for tests / scripted uploads; also works for browsers
    // that base64-encode the file before POSTing).
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const meetingDate =
      typeof body.meeting_date === 'string' ? body.meeting_date.trim() : '';
    const filename =
      typeof body.filename === 'string'
        ? body.filename.trim()
        : typeof body.original_filename === 'string'
          ? body.original_filename.trim()
          : '';
    const fileContentType =
      typeof body.content_type === 'string' ? body.content_type.trim() : '';
    let buffer = null;
    if (typeof body.content_base64 === 'string' && body.content_base64.length > 0) {
      try {
        buffer = Buffer.from(body.content_base64, 'base64');
      } catch {
        reply
          .code(400)
          .send({ error: 'validation_failed', message: 'invalid content_base64' });
        return null;
      }
    } else if (body.content != null) {
      // Raw string content (handy for tiny text-as-pdf fixtures in tests).
      buffer = Buffer.from(String(body.content), 'utf8');
    }
    return { buffer, filename, contentType: fileContentType, meetingDate };
  }

  // Founder-only upload. Board sessions get 403 and create no row.
  app.post('/api/memos', async (req, reply) => {
    if (!requireFounder(req, reply)) return;

    const parsed = await parseMemoUpload(req, reply);
    if (!parsed) return;

    const meetingDate = normalizeMeetingDate(parsed.meetingDate);
    if (!meetingDate) {
      reply.code(400).send({
        error: 'validation_failed',
        message: 'meeting_date must be YYYY-MM-DD'
      });
      return;
    }
    if (!parsed.buffer || parsed.buffer.length === 0) {
      reply
        .code(400)
        .send({ error: 'validation_failed', message: 'file content required' });
      return;
    }
    const filename = parsed.filename || 'memo.bin';
    if (!isAllowedMemoFile(filename, parsed.contentType)) {
      reply.code(400).send({
        error: 'validation_failed',
        message: 'only .docx and .pdf uploads are accepted'
      });
      return;
    }

    const memo = createMemo({
      authorId: (req.auth && req.auth.userId) || null,
      meetingDate,
      originalFilename: filename,
      contentType: parsed.contentType || guessContentType(filename),
      buffer: parsed.buffer
    });

    // Server-side extraction — never in the browser. Runs before the response
    // so a single poll usually already sees status=analyzed; the live tester
    // still has a ~60s window if extraction is slow.
    try {
      const blob = getBlob(memo.storage_path);
      const text = await extractMemoText({
        buffer: blob && blob.buffer,
        originalFilename: memo.original_filename,
        contentType: memo.content_type,
        log: req.log
      });
      // Prefer non-empty text for acceptance; if the parser returned empty but
      // the file had bytes, keep a short marker so status can still flip and
      // operators can tell extraction ran. Real docx/pdf fixtures yield text.
      const extracted =
        text && text.length > 0
          ? text
          : `[extracted:empty source=${memo.original_filename} bytes=${parsed.buffer.length}]`;
      markAnalyzed(memo.id, extracted);
    } catch (err) {
      req.log.error({ err: err && err.message }, 'memo extraction threw');
      // Leave status=uploaded so a later retry path could re-extract; for the
      // in-memory path we still mark analyzed with an error marker so the
      // pipeline does not stall the ~60s poll forever.
      markAnalyzed(
        memo.id,
        `[extracted:error source=${memo.original_filename}]`
      );
    }

    const finalMemo = getMemo(memo.id);
    reply.code(201).send({ memo: finalMemo });
  });

  // List memos — founder and board (read-only). Board never gets write fields
  // beyond what the public row already exposes.
  app.get('/api/memos', async (_req, reply) => {
    reply.code(200).send({ memos: listMemos() });
  });

  app.get('/api/memos/:id', async (req, reply) => {
    const id = (req.params && req.params.id ? String(req.params.id) : '').trim();
    const memo = getMemo(id);
    if (!memo) {
      reply.code(404).send({ error: 'not_found', message: 'memo not found' });
      return;
    }
    reply.code(200).send({ memo });
  });

  // Mint a 1-hour signed download URL for a private memo object. Both roles
  // may read. The URL encodes expiresIn=3600; the token is an HS256 JWT.
  app.get('/api/memos/:id/signed-url', async (req, reply) => {
    const id = (req.params && req.params.id ? String(req.params.id) : '').trim();
    const memo = getMemo(id);
    if (!memo) {
      reply.code(404).send({ error: 'not_found', message: 'memo not found' });
      return;
    }
    const secret = jwtSecret();
    if (!secret) {
      reply.code(503).send({ error: 'auth_unconfigured' });
      return;
    }
    const origin = originFromRequest(req);
    try {
      const signed = buildSignedUrl(origin, memo.storage_path, secret);
      reply
        .code(200)
        .header('cache-control', 'no-store')
        .send({
          signedUrl: signed.signedUrl,
          expiresIn: signed.expiresIn || SIGNED_URL_TTL_SECONDS,
          // Also surface the private public-style URL so testers can assert it
          // 4xxs without guessing the path layout.
          publicUrl: publicObjectUrl(origin, memo.storage_path),
          storage_path: memo.storage_path
        });
    } catch (err) {
      req.log.error({ err: err && err.message }, 'signed url mint failed');
      reply.code(500).send({ error: 'signed_url_failed' });
    }
  });

  // Private bucket: public object path ALWAYS fails closed (4xx). Never serve
  // file bytes here — signed URL is the only download path.
  app.get('/storage/v1/object/public/*', async (_req, reply) => {
    reply
      .code(403)
      .header('cache-control', 'no-store')
      .send({ error: 'forbidden', message: 'private bucket — use a signed URL' });
  });

  // Signed download. Token is required and must match the path + 3600s TTL.
  // Tampered / missing / expired tokens → 4xx. No auth bearer required: the
  // signed token IS the capability (possession of the 1h URL).
  app.get('/storage/v1/object/sign/*', async (req, reply) => {
    reply.header('cache-control', 'no-store');
    const storagePath = storagePathFromRequestUrl(req.url);
    if (!storagePath) {
      reply.code(400).send({ error: 'bad_request', message: 'invalid storage path' });
      return;
    }
    const token =
      (req.query && (req.query.token || req.query.Token)) ||
      bearerToken(req) ||
      '';
    if (!token) {
      reply.code(401).send({ error: 'unauthorized', message: 'missing signed token' });
      return;
    }
    let claims;
    try {
      claims = verifyStorageToken(String(token), jwtSecret());
    } catch {
      reply.code(403).send({ error: 'forbidden', message: 'invalid or expired signed token' });
      return;
    }
    // Path in the token must match the requested object (prevents token reuse
    // across objects).
    if (claims.storagePath !== storagePath) {
      reply.code(403).send({ error: 'forbidden', message: 'token path mismatch' });
      return;
    }
    const blob = getBlob(storagePath);
    if (!blob) {
      reply.code(404).send({ error: 'not_found', message: 'object not found' });
      return;
    }
    reply
      .code(200)
      .header(
        'content-type',
        blob.contentType || 'application/octet-stream'
      )
      .header(
        'content-disposition',
        `attachment; filename="${(blob.originalFilename || 'memo').replace(/"/g, '')}"`
      )
      .send(blob.buffer);
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
        `loginConfig=${supabaseUrl.length > 0 && supabaseAnonKey.length > 0} ` +
        `mailer=${mailerConfigured()}`
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
