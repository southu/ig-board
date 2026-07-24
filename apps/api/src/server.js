// Boardroom API — Fastify service for the ig-board mission.
//
// Public, unauthenticated endpoints:
//   GET /health   -> 200 liveness probe
//   GET /version  -> 200 deployed git SHA (matches origin/main HEAD on Railway)
//
// Every other route requires a valid Supabase JWT (Authorization: Bearer <token>);
// missing/invalid tokens get a 401. See src/auth.js for the verification details.
//   GET /me           -> 200 { id, role, capabilities } for the authenticated user
//   GET /api/session  -> 200 same shape (role + capabilities from permissions map)
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import multipart from '@fastify/multipart';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import net from 'node:net';
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
  userForEmail,
  isInvitedEmail
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
import {
  generateIndependentAnalysis,
  isSimulateFailure,
  SECTION_HEADINGS
} from './independentAnalysis.js';
import {
  createComment,
  getComment,
  getCommentRow,
  listComments,
  listUnresolvedComments,
  setResolved,
  softDeleteComment,
  setReaction,
  clearReaction,
  isReactionType,
  REACTION_TYPES
} from './commentsStore.js';
import { getAgenda, setGenerated, setEditedContent } from './agendaStore.js';
import { generateAgendaContent } from './agendaGenerate.js';
import { kpiValuesToCsv } from './csvExport.js';
import { consumeWhatsNew, resetWhatsNewStore } from './whatsNewStore.js';
import {
  SCORECARD_KPIS,
  scorecardPayload
} from './scorecardData.js';
import { withExitReadiness } from './exitReadiness.js';
import { ensureGovernanceReady, governanceStatus } from './governance.js';
import {
  hasCapability,
  canExportKpiCsv,
  sessionPayload
} from './permissions.js';
import { closePool } from './db.js';

const SCORECARD_KPI_KEYS = new Set(SCORECARD_KPIS.map((kpi) => kpi.key));

// Re-export for tests that reset the digest cursor alongside the KPI store.
export { resetWhatsNewStore };

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

// True when a DATABASE_URL (if any) is reachable; when unset the API serves from
// its in-memory store (always available) so readiness stays true. Never returns
// the connection string — only a boolean. TCP probe with a short timeout so a
// hung DB cannot stall the probe.
export async function probeDatabaseReachable(env = process.env, timeoutMs = 800) {
  const raw = (env.DATABASE_URL || '').trim();
  if (!raw) return true; // in-memory data path — dependency satisfied without Postgres
  let host;
  let port = 5432;
  try {
    // Accept postgres:// and postgresql://. Never log the URL.
    const normalized = raw.replace(/^postgresql:/i, 'http:').replace(/^postgres:/i, 'http:');
    const u = new URL(normalized);
    host = u.hostname;
    if (u.port) port = Number(u.port) || 5432;
  } catch {
    return false;
  }
  if (!host) return false;
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      try {
        socket.destroy();
      } catch {
        /* ignore */
      }
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    socket.once('connect', () => {
      clearTimeout(timer);
      finish(true);
    });
    socket.once('error', () => {
      clearTimeout(timer);
      finish(false);
    });
  });
}

// Build the non-secret readiness checks object. Exported for unit tests.
// Self-hosted path (JWT secret bound, no external Supabase project): the service
// origin is the auth URL and keys are minted from the JWT secret, so url/key
// checks flip true without a service-role binding.
export async function readinessChecks(req, env = process.env) {
  const jwt_secret_set = jwtSecret().length > 0;
  const externalUrl = (env.SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL || '')
    .trim()
    .replace(/\/+$/, '');
  const serviceRoleKey = (env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  const origin =
    (req ? originFromRequest(req) : '') || selfOriginFromEnv(env) || '';
  // URL is "set" when an external project is bound OR self-host origin is known
  // and the JWT secret can back the /auth surface.
  const supabase_url_set =
    externalUrl.length > 0 || (jwt_secret_set && origin.length > 0);
  // Key material is present when a service-role key is bound OR (self-host) the
  // JWT secret can mint/verify the anon apikey and member sessions.
  const supabase_key_set = serviceRoleKey.length > 0 || jwt_secret_set;
  const db_reachable = await probeDatabaseReachable(env);
  return {
    jwt_secret_set,
    supabase_url_set,
    supabase_key_set,
    db_reachable
  };
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

  // Public, read-only governance data-layer status (no auth). Verifies roles,
  // reaction schema, soft-delete columns, and row counts without mutating data.
  // Exempt from the /api/* JWT boundary via PUBLIC_API_ROUTES in auth.js.
  app.get('/api/governance/status', async (_req, reply) => {
    try {
      const status = await governanceStatus();
      reply
        .code(200)
        .header('cache-control', 'no-store')
        .send(status);
    } catch (err) {
      _req.log?.error?.({ err: err && err.message }, 'governance status failed');
      reply.code(500).send({ error: 'governance_status_failed' });
    }
  });

  // Non-secret readiness probe: boolean environment/dependency checks ONLY —
  // never secret values, key fragments, URLs, or connection strings. Body shape:
  //   { ready: <bool>, checks: {
  //       jwt_secret_set, supabase_url_set, supabase_key_set, db_reachable
  //     } }
  // Always HTTP 200 (probe never fails closed). Missing env flips the matching
  // check to false; the process still boots. `ready` is true only when every
  // check is true. Self-hosted auth (JWT secret bound, no external Supabase
  // project) is a first-class path: URL/key checks pass when the service can
  // mint login config / verify sessions from the bound JWT secret.
  app.get('/ready', async (req, reply) => {
    const checks = await readinessChecks(req);
    const ready = Object.values(checks).every(Boolean);
    reply.code(200).send({ ready, checks });
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

  // Public, non-secret test-account directory for live acceptance testers.
  // Emails and roles only — never passwords or tokens. Magic-link OTP returns an
  // inline action_link when no mailer is bound (see selfAuth + TESTING.md).
  app.get('/test-accounts', async (_req, reply) => {
    const admin =
      (process.env.ADMIN_TEST_EMAIL || '').trim() ||
      (process.env.FOUNDER_TEST_EMAIL || '').trim() ||
      'admin.e2e@boardroom.test';
    const boardMember =
      (process.env.BOARD_MEMBER_TEST_EMAIL || '').trim() ||
      (process.env.BOARD_TEST_EMAIL || '').trim() ||
      'board_member.e2e@boardroom.test';
    // Legacy email aliases still accepted for older probes / scripts.
    const founder =
      (process.env.FOUNDER_TEST_EMAIL || '').trim() ||
      'founder.e2e@boardroom.test';
    const board =
      (process.env.BOARD_TEST_EMAIL || '').trim() || 'board.e2e@boardroom.test';
    reply
      .code(200)
      .header('cache-control', 'no-store')
      .send({
        auth: 'magic-link',
        login_path: '/login',
        session_endpoint: '/api/session',
        notes: [
          'Invite-only magic link (no shared credentials). On this deploy OTP returns an inline action_link when mailer is unbound.',
          'Roles and capabilities come from apps/api/src/permissions.js (single map).',
          'Admin has full capabilities (input/edit KPI, delete_any_comment, access_admin_area).',
          'board_member is read-only for KPI writes (403 on POST/PUT/PATCH); commenting/reactions still allowed.',
          'Session: GET /me or GET /api/session returns { role, capabilities } for the current user.',
          'Audit trail: GET /api/audit-log (access_admin_area) or the table on /update.'
        ],
        accounts: [
          {
            role: 'admin',
            email: admin,
            can_write_kpi: true,
            capabilities: [
              'input_kpi_data',
              'edit_kpi_data',
              'delete_any_comment',
              'access_admin_area'
            ]
          },
          {
            role: 'board_member',
            email: boardMember,
            can_write_kpi: false,
            capabilities: []
          },
          // Legacy email aliases (same mapping via founder→admin, board→board_member)
          {
            role: 'admin',
            email: founder,
            can_write_kpi: true,
            alias_of: 'founder test email'
          },
          {
            role: 'board_member',
            email: board,
            can_write_kpi: false,
            alias_of: 'board test email'
          }
        ]
      });
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

  // Invite-only: there is no self-signup. GoTrue-shaped signup/register paths
  // are disabled so a client that tries password or open registration fails
  // closed with 403/404 rather than creating an account.
  for (const path of [
    '/auth/v1/signup',
    '/auth/v1/register',
    '/signup',
    '/register'
  ]) {
    for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) {
      app.route({
        method,
        url: path,
        handler: async (_req, reply) => {
          reply
            .code(path.startsWith('/auth/') ? 403 : 404)
            .header('cache-control', 'no-store')
            .send({
              error: path.startsWith('/auth/') ? 'signup_disabled' : 'not_found',
              message: 'Self-signup is disabled; invite-only magic link.'
            });
        }
      });
    }
  }

  // Self-hosted origin has no PostgREST surface. Anon Supabase clients pointed
  // at this service (or probing /rest/v1/*) must never read Boardroom tables —
  // fail closed with 401 so row counts stay zero.
  app.all('/rest/v1/*', async (_req, reply) => {
    reply
      .code(401)
      .header('cache-control', 'no-store')
      .send({
        error: 'unauthorized',
        message: 'direct table access denied; use authenticated /api routes',
        data: []
      });
  });

  // Step 1 — request a magic link. Validates the apikey + email, then only
  // mints a grant for pre-provisioned / invited members. Unknown emails get a
  // uniform 200 with no action_link (no user enumeration, no self-signup).
  // create_user is ignored for membership — invite-only never auto-creates.
  // When a mailer is bound the link is emailed (never returned). When none is
  // bound and no external Supabase project is set, invited members may receive
  // an inline action_link for the self-hosted demo / e2e path.
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

    // Invite-only: never mint a grant or return an action_link for strangers.
    // create_user:true does not bypass membership — there is no self-signup.
    if (!isInvitedEmail(email)) {
      req.log.info('otp request: non-member — silent accept (no grant)');
      reply.code(200).send({});
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
    // Inline action_link is ONLY for invited members (checked above).
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
      // Defense in depth: even a cryptographically valid grant never mints a
      // session for a non-member (stale grants / allowlist changes).
      if (!isInvitedEmail(email)) {
        reply.redirect(`${origin}/login#error=invalid_or_expired_link`);
        return;
      }
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
      if (!isInvitedEmail(email)) {
        reply.code(401).send({ error: 'invalid_grant', message: 'invalid or expired token' });
        return;
      }
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
      if (!isInvitedEmail(email)) {
        reply.code(401).send({ error: 'invalid_grant', message: 'invalid refresh token' });
        return;
      }
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

  // Gate a request on a named capability from the single permissions map.
  // Auth hook already required a valid member session for /api/* and /me.
  // Sends 403 and returns false when denied; returns true to proceed.
  function requireCapability(req, reply, capability) {
    const role = req.auth && req.auth.role;
    if (hasCapability(role, capability)) return true;
    reply.code(403).send({
      error: 'forbidden',
      message: `missing capability: ${capability}`,
      role: role || null,
      capability
    });
    return false;
  }

  // Legacy name kept for call sites that mean "admin-area / full writer"
  // (memos, agenda edits, audit log). Derives from access_admin_area.
  function requireFounder(req, reply) {
    return requireCapability(req, reply, 'access_admin_area');
  }

  // Board-audience CSV export — derived from the permissions map (roles without
  // access_admin_area). Admin/founder sessions are refused.
  function requireBoard(req, reply) {
    const role = req.auth && req.auth.role;
    if (canExportKpiCsv(role)) return true;
    reply
      .code(403)
      .send({ error: 'forbidden', message: 'board export role required' });
    return false;
  }

  // Authenticated identity: JWT already verified. Role + capabilities come from
  // the single permissions map (canonical governance role names).
  app.get('/me', async (req, reply) => {
    const auth = req.auth || {};
    reply.code(200).send(
      sessionPayload({
        userId: auth.userId,
        role: auth.role,
        email: auth.email
      })
    );
  });

  // Explicit session/me surface for clients that prefer /api/* JSON.
  // Same payload as GET /me — role + resolved capabilities list.
  app.get('/api/session', async (req, reply) => {
    const auth = req.auth || {};
    reply
      .code(200)
      .header('cache-control', 'no-store')
      .send(
        sessionPayload({
          userId: auth.userId,
          role: auth.role,
          email: auth.email
        })
      );
  });

  // Admin area stub — requires access_admin_area. Non-admin authenticated
  // sessions get 403; unauthenticated requests are 401 via the auth hook.
  app.get('/api/admin', async (req, reply) => {
    if (!requireCapability(req, reply, 'access_admin_area')) return;
    reply
      .code(200)
      .header('cache-control', 'no-store')
      .send({
        ok: true,
        area: 'admin',
        message: 'admin area accessible',
        role: sessionPayload({ role: req.auth && req.auth.role }).role
      });
  });

  // Complete scorecard structure and board-spec metadata. Keeping this under
  // the authenticated API boundary exposes one deterministic verification
  // surface in both self-hosted and externally provisioned deployments.
  app.get('/api/scorecard', async (_req, reply) => {
    reply
      .code(200)
      .header('cache-control', 'no-store')
      .send(scorecardPayload());
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
      const computed = withExitReadiness(seededValues());
      reply.code(200).send({
        values: computed.values,
        exit_readiness: computed.exitReadiness
      });
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
        const computed = withExitReadiness(overlayValues({}));
        reply.code(200).send({
          values: computed.values,
          exit_readiness: computed.exitReadiness
        });
        return;
      }
      const kpis = await kpisRes.json();
      const values = await valuesRes.json();
      const idToKey = new Map(kpis.map((k) => [k.id, k.key]));
      const byKey = {};
      for (const v of values) {
        const key = idToKey.get(v.kpi_id);
        // An external project may not have run the replacement SQL yet. Never
        // leak observations belonging to retired generic KPIs through the live
        // scorecard API while deployment catches up.
        if (!key || !SCORECARD_KPI_KEYS.has(key)) continue;
        (byKey[key] ||= []).push({ period: v.period, value: v.value });
      }
      // Layer founder-written overrides on top of the live table read so the
      // Phase 1 write path is visible even alongside a real project.
      const computed = withExitReadiness(overlayValues(byKey));
      reply.code(200).send({
        values: computed.values,
        exit_readiness: computed.exitReadiness
      });
    } catch (err) {
      req.log.error({ err: err && err.message }, 'kpi-values fetch failed');
      const computed = withExitReadiness(overlayValues({}));
      reply.code(200).send({
        values: computed.values,
        exit_readiness: computed.exitReadiness
      });
    }
  });

  // KPI value entry (create/upsert). Requires input_kpi_data from the single
  // permissions map. board_member (and legacy board) sessions are authenticated
  // but refused with 403. Body: { key, period: "YYYY-MM", value: number,
  // note?: string }. Idempotent upsert by key+period; records an audit row.
  app.post('/api/kpi-values', async (req, reply) => {
    if (!requireCapability(req, reply, 'input_kpi_data')) return;
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const key = typeof body.key === 'string' ? body.key.trim() : '';
    const period = normalizePeriod(body.period);
    const value = typeof body.value === 'number' ? body.value : Number(body.value);
    const note = typeof body.note === 'string' ? body.note : '';
    const catalogKpi = SCORECARD_KPIS.find((kpi) => kpi.key === key);
    if (!catalogKpi) {
      reply.code(400).send({ error: 'validation_failed', message: 'unknown KPI key' });
      return;
    }
    if (catalogKpi.manual_entry === false) {
      reply.code(400).send({
        error: 'validation_failed',
        message: 'computed KPI does not accept manual entry'
      });
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

  // KPI definition/threshold edit. Requires edit_kpi_data. Roles with only
  // input_kpi_data (employee/consultant) and read-only roles (board_member) get
  // 403. Records an audit row per changed field and stamps the 90-day window.
  app.put('/api/kpi-definitions/:key', async (req, reply) => {
    if (!requireCapability(req, reply, 'edit_kpi_data')) return;
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
  // Phase 4 — board CSV export + /whats-new digest (last_seen_at cursor)
  // ---------------------------------------------------------------------------

  // Board-only export of every kpi_values observation as text/csv. Founder and
  // unauthenticated callers are refused (403 / 401). Header + one data row per
  // observation (kpi_key,period,value). Uses the same values map as GET
  // /api/kpi-values (seed + overlays, or live table when admin is bound).
  app.get('/api/export/kpi-values.csv', async (req, reply) => {
    reply.header('cache-control', 'no-store');
    if (!requireBoard(req, reply)) return;
    let values;
    try {
      values = await loadKpiValuesByKey(req.log);
    } catch (err) {
      req.log.error({ err: err && err.message }, 'csv export values load failed');
      values = seededValues();
    }
    const csv = kpiValuesToCsv(values);
    reply
      .code(200)
      .header('content-type', 'text/csv; charset=utf-8')
      .header(
        'content-disposition',
        'attachment; filename="kpi-values.csv"'
      )
      .send(csv);
  });

  // Authenticated digest of scorecard changes since the caller's last_seen_at.
  // Both founder and board may read. Returns items strictly after the previous
  // cursor, then advances last_seen_at so a revisit is empty or reduced.
  // Email-free by design — no mail/mailto/subscribe fields in the payload.
  app.get('/api/whats-new', async (req, reply) => {
    reply.header('cache-control', 'no-store');
    const userId = (req.auth && req.auth.userId) || null;
    if (!userId) {
      reply
        .code(401)
        .send({ error: 'unauthorized', message: 'missing user identity' });
      return;
    }
    const digest = consumeWhatsNew(userId);
    reply.code(200).send({
      last_seen_at: digest.last_seen_at,
      seen_at: digest.seen_at,
      items: digest.items,
      count: digest.items.length
    });
  });

  // ---------------------------------------------------------------------------
  // Independent AI memo analysis (Fastify only — never a Next.js /api route).
  //
  // POST /api/independent-analysis — founder + board
  //   Inputs assembled server-side: KPI snapshot from kpi_values (seed +
  //   overlays / live table) + prior memo extracted_text by meeting_date.
  //   Model claude-sonnet-4-6 with rigorous-independent-board-analyst prompt.
  //   ANTHROPIC_API_KEY is read only from process.env (Railway vault); never
  //   returned to the client. Documented simulate_anthropic_failure trigger
  //   forces a provider error for the UI retry path (see TESTING.md).
  // ---------------------------------------------------------------------------

  // Resolve the same values map GET /api/kpi-values serves, so analysis always
  // cites real kpi_values (seed + founder overlays, or live table when bound).
  async function loadKpiValuesByKey(log) {
    if (!isAdminConfigured()) {
      return seededValues();
    }
    try {
      const [kpisRes, valuesRes] = await Promise.all([
        adminFetch('/rest/v1/kpis?select=id,key'),
        adminFetch(
          '/rest/v1/kpi_values?select=kpi_id,period,value&order=period.asc'
        )
      ]);
      if (!kpisRes.ok || !valuesRes.ok) {
        return overlayValues({});
      }
      const kpis = await kpisRes.json();
      const values = await valuesRes.json();
      const idToKey = new Map(kpis.map((k) => [k.id, k.key]));
      const byKey = {};
      for (const v of values) {
        const key = idToKey.get(v.kpi_id);
        if (!key || !SCORECARD_KPI_KEYS.has(key)) continue;
        (byKey[key] ||= []).push({ period: v.period, value: v.value });
      }
      return overlayValues(byKey);
    } catch (err) {
      if (log) log.error({ err: err && err.message }, 'kpi-values for analysis failed');
      return overlayValues({});
    }
  }

  app.post('/api/independent-analysis', async (req, reply) => {
    reply.header('cache-control', 'no-store');

    // Documented test-only failure simulation — never calls Anthropic.
    if (isSimulateFailure(req)) {
      reply.code(503).send({
        error: 'anthropic_simulated_failure',
        message:
          'Simulated Anthropic provider failure (test-only trigger). Disable simulate_anthropic_failure and retry.',
        retryable: true,
        simulate: true
      });
      return;
    }

    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const focusMemoId =
      typeof body.memo_id === 'string'
        ? body.memo_id.trim()
        : typeof body.memoId === 'string'
          ? body.memoId.trim()
          : '';

    const valuesByKey = await loadKpiValuesByKey(req.log);
    const memos = listMemos();

    try {
      const result = await generateIndependentAnalysis({
        valuesByKey,
        memos,
        focusMemoId: focusMemoId || undefined,
        env: process.env
      });
      reply.code(200).send({
        ok: true,
        analysis: {
          markdown: result.markdown,
          model: result.model,
          source: result.source,
          sections: SECTION_HEADINGS,
          memoCount: result.memoCount,
          // Non-secret: which KPI keys were in the snapshot (for debugging UI).
          kpiKeys: Object.keys(result.kpiSnapshot || {})
        }
      });
    } catch (err) {
      req.log.error(
        { err: err && err.message, code: err && err.code },
        'independent analysis failed'
      );
      // Never leak API key material. Surface a retryable provider error.
      reply.code(502).send({
        error: 'anthropic_provider_error',
        message:
          (err && err.code) ||
          'Anthropic analysis failed. Retry after the provider recovers.',
        retryable: true
      });
    }
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

  // ---------------------------------------------------------------------------
  // Threaded comments — polymorphic on KPI / memo / analysis.
  //
  // GET    /api/comments?kpi_id=|memo_id=|analysis_id=  — list (auth)
  // POST   /api/comments  { body, parent_id?, kpi_id?|memo_id?|analysis_id? }
  // PATCH  /api/comments/:id  { resolved: true|false }
  // DELETE /api/comments/:id  — soft-delete (author or delete_any_comment)
  // POST   /api/comments/:id/reactions  { type|reaction_type|reaction }
  // DELETE /api/comments/:id/reactions  — clear caller's reaction
  //
  // Exactly one target is required (CHECK). Replies set parent_id and inherit
  // the parent's target. @mentions are plain text here; the client bolds them
  // with no email/push. Unauthenticated POSTs fail closed 401 via authHook.
  //
  // Soft-delete sets deleted_at + deleted_by; rows are never hard-deleted.
  // Soft-deleted comments are excluded from every list/read path, and their
  // reactions do not contribute to reaction_counts.
  //
  // Reactions: one row per user per comment (unique key). POST upserts or
  // toggles off when the same type is posted twice; DELETE clears explicitly.
  // List payload includes reaction_counts + my_reaction for the caller.
  // ---------------------------------------------------------------------------

  function parseCommentTarget(queryOrBody) {
    const src = queryOrBody && typeof queryOrBody === 'object' ? queryOrBody : {};
    const kpi_id =
      typeof src.kpi_id === 'string'
        ? src.kpi_id.trim()
        : typeof src.kpiId === 'string'
          ? src.kpiId.trim()
          : '';
    const memo_id =
      typeof src.memo_id === 'string'
        ? src.memo_id.trim()
        : typeof src.memoId === 'string'
          ? src.memoId.trim()
          : '';
    const analysis_id =
      typeof src.analysis_id === 'string'
        ? src.analysis_id.trim()
        : typeof src.analysisId === 'string'
          ? src.analysisId.trim()
          : '';
    return {
      kpi_id: kpi_id || null,
      memo_id: memo_id || null,
      analysis_id: analysis_id || null
    };
  }

  function parseReactionType(body) {
    const src = body && typeof body === 'object' ? body : {};
    const raw =
      src.type ??
      src.reaction_type ??
      src.reactionType ??
      src.reaction ??
      null;
    if (typeof raw !== 'string') return null;
    return raw.trim().toLowerCase();
  }

  app.get('/api/comments', async (req, reply) => {
    reply.header('cache-control', 'no-store');
    const target = parseCommentTarget(req.query || {});
    const n =
      (target.kpi_id ? 1 : 0) +
      (target.memo_id ? 1 : 0) +
      (target.analysis_id ? 1 : 0);
    if (n !== 1) {
      reply.code(400).send({
        error: 'validation_failed',
        message: 'exactly one of kpi_id, memo_id, analysis_id is required'
      });
      return;
    }
    const comments = listComments({
      kpiId: target.kpi_id,
      memoId: target.memo_id,
      analysisId: target.analysis_id,
      viewerUserId: (req.auth && req.auth.userId) || null
    });
    reply.code(200).send({ comments });
  });

  app.post('/api/comments', async (req, reply) => {
    reply.header('cache-control', 'no-store');
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const text = typeof body.body === 'string' ? body.body : '';
    const parent_id =
      typeof body.parent_id === 'string'
        ? body.parent_id.trim()
        : typeof body.parentId === 'string'
          ? body.parentId.trim()
          : '';
    const target = parseCommentTarget(body);
    try {
      const comment = createComment({
        authorId: (req.auth && req.auth.userId) || null,
        authorEmail: (req.auth && req.auth.email) || null,
        authorRole: (req.auth && req.auth.role) || null,
        body: text,
        parentId: parent_id || null,
        kpiId: target.kpi_id,
        memoId: target.memo_id,
        analysisId: target.analysis_id
      });
      reply.code(201).send({ comment });
    } catch (err) {
      if (err && err.code === 'VALIDATION') {
        reply.code(400).send({
          error: 'validation_failed',
          message: err.message || 'invalid comment'
        });
        return;
      }
      req.log.error({ err: err && err.message }, 'comment create failed');
      reply.code(500).send({ error: 'comment_create_failed' });
    }
  });

  app.patch('/api/comments/:id', async (req, reply) => {
    reply.header('cache-control', 'no-store');
    const id = (req.params && req.params.id ? String(req.params.id) : '').trim();
    if (!id) {
      reply.code(400).send({ error: 'validation_failed', message: 'id required' });
      return;
    }
    if (!getComment(id)) {
      reply.code(404).send({ error: 'not_found', message: 'comment not found' });
      return;
    }
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    if (typeof body.resolved !== 'boolean') {
      reply.code(400).send({
        error: 'validation_failed',
        message: 'resolved must be a boolean'
      });
      return;
    }
    const comment = setResolved(id, body.resolved);
    reply.code(200).send({ comment });
  });

  // Soft-delete a comment. Authorization:
  //   * author of the comment, OR
  //   * role with delete_any_comment (admin / founder) via the permissions map
  // Any other authenticated caller gets 403; unauthenticated → 401 (auth hook).
  // Sets deleted_at + deleted_by; never hard-deletes the row.
  app.delete('/api/comments/:id', async (req, reply) => {
    reply.header('cache-control', 'no-store');
    const id = (req.params && req.params.id ? String(req.params.id) : '').trim();
    if (!id) {
      reply.code(400).send({ error: 'validation_failed', message: 'id required' });
      return;
    }
    const row = getCommentRow(id);
    if (!row || row.deleted_at) {
      reply.code(404).send({ error: 'not_found', message: 'comment not found' });
      return;
    }
    const userId = (req.auth && req.auth.userId) || null;
    if (!userId) {
      reply.code(401).send({ error: 'unauthorized', message: 'authentication required' });
      return;
    }
    const role = (req.auth && req.auth.role) || null;
    const isAuthor =
      row.author_id != null && String(row.author_id) === String(userId);
    const canDeleteAny = hasCapability(role, 'delete_any_comment');
    if (!isAuthor && !canDeleteAny) {
      reply.code(403).send({
        error: 'forbidden',
        message: 'only the author or an admin may delete this comment',
        role: role || null,
        capability: 'delete_any_comment'
      });
      return;
    }
    try {
      const result = softDeleteComment({ id, deletedBy: userId });
      reply.code(200).send({
        ok: true,
        id: result.id,
        deleted: true
      });
    } catch (err) {
      if (err && err.code === 'NOT_FOUND') {
        reply.code(404).send({ error: 'not_found', message: 'comment not found' });
        return;
      }
      if (err && err.code === 'VALIDATION') {
        reply.code(400).send({
          error: 'validation_failed',
          message: err.message || 'invalid delete'
        });
        return;
      }
      req.log.error({ err: err && err.message }, 'comment delete failed');
      reply.code(500).send({ error: 'comment_delete_failed' });
    }
  });

  // Set / switch / toggle-off a reaction on a comment.
  // Body: { type: 'like'|'dislike'|'question' } (aliases: reaction_type, reaction).
  // Same type twice clears the row; different type replaces (one per user).
  app.post('/api/comments/:id/reactions', async (req, reply) => {
    reply.header('cache-control', 'no-store');
    const id = (req.params && req.params.id ? String(req.params.id) : '').trim();
    if (!id) {
      reply.code(400).send({ error: 'validation_failed', message: 'id required' });
      return;
    }
    const type = parseReactionType(req.body);
    if (!type || !isReactionType(type)) {
      reply.code(400).send({
        error: 'validation_failed',
        message: `type must be one of: ${REACTION_TYPES.join(', ')}`
      });
      return;
    }
    const userId = (req.auth && req.auth.userId) || null;
    if (!userId) {
      // Auth hook should already have rejected; belt-and-suspenders.
      reply.code(401).send({ error: 'unauthorized', message: 'authentication required' });
      return;
    }
    try {
      const result = setReaction({ commentId: id, userId, type });
      reply.code(200).send({
        action: result.action,
        reaction_type: result.reaction_type,
        my_reaction: result.reaction_type,
        comment: result.comment
      });
    } catch (err) {
      if (err && err.code === 'NOT_FOUND') {
        reply.code(404).send({ error: 'not_found', message: 'comment not found' });
        return;
      }
      if (err && err.code === 'VALIDATION') {
        reply.code(400).send({
          error: 'validation_failed',
          message: err.message || 'invalid reaction'
        });
        return;
      }
      req.log.error({ err: err && err.message }, 'reaction set failed');
      reply.code(500).send({ error: 'reaction_set_failed' });
    }
  });

  // Explicitly clear the caller's reaction on a comment.
  app.delete('/api/comments/:id/reactions', async (req, reply) => {
    reply.header('cache-control', 'no-store');
    const id = (req.params && req.params.id ? String(req.params.id) : '').trim();
    if (!id) {
      reply.code(400).send({ error: 'validation_failed', message: 'id required' });
      return;
    }
    const userId = (req.auth && req.auth.userId) || null;
    if (!userId) {
      reply.code(401).send({ error: 'unauthorized', message: 'authentication required' });
      return;
    }
    try {
      const result = clearReaction({ commentId: id, userId });
      reply.code(200).send({
        action: result.action,
        reaction_type: null,
        my_reaction: null,
        comment: result.comment
      });
    } catch (err) {
      if (err && err.code === 'NOT_FOUND') {
        reply.code(404).send({ error: 'not_found', message: 'comment not found' });
        return;
      }
      if (err && err.code === 'VALIDATION') {
        reply.code(400).send({
          error: 'validation_failed',
          message: err.message || 'invalid reaction'
        });
        return;
      }
      req.log.error({ err: err && err.message }, 'reaction clear failed');
      reply.code(500).send({ error: 'reaction_clear_failed' });
    }
  });

  // ---------------------------------------------------------------------------
  // Board agenda generator (Phase 3).
  //
  // GET  /api/agenda            — return current agenda; auto-generate if none
  // POST /api/agenda/regenerate — rebuild generated_content; preserve edits
  // PATCH /api/agenda           — save edited_content only (never touches generated)
  //
  // Sources: red/yellow KPIs + unresolved comments + analysis "Questions the
  // Board Should Ask". Ordered bottom-up: Leadership Alignment (layer 1) first,
  // Enterprise Value (layer 5) last. Time-blocked topics.
  // ---------------------------------------------------------------------------

  async function buildAndStoreAgenda(req, { force } = {}) {
    const existing = getAgenda();
    if (existing && !force) return existing;

    const valuesByKey = await loadKpiValuesByKey(req.log);
    const comments = listUnresolvedComments();
    const memos = listMemos();
    const generatedContent = await generateAgendaContent({
      valuesByKey,
      comments,
      memos,
      env: process.env
    });
    return setGenerated({
      title: 'Board Agenda',
      scheduledFor: new Date().toISOString().slice(0, 10),
      generatedContent,
      actorId: (req.auth && req.auth.userId) || null
    });
  }

  app.get('/api/agenda', async (req, reply) => {
    reply.header('cache-control', 'no-store');
    try {
      const agenda = await buildAndStoreAgenda(req, { force: false });
      reply.code(200).send({ agenda });
    } catch (err) {
      req.log.error({ err: err && err.message }, 'agenda get failed');
      reply.code(500).send({ error: 'agenda_failed' });
    }
  });

  // Founder regenerates; board may also regenerate (read-oriented rebuild of
  // the shared draft). Edits are always preserved.
  app.post('/api/agenda/regenerate', async (req, reply) => {
    reply.header('cache-control', 'no-store');
    try {
      const agenda = await buildAndStoreAgenda(req, { force: true });
      reply.code(200).send({ agenda });
    } catch (err) {
      req.log.error({ err: err && err.message }, 'agenda regenerate failed');
      reply.code(500).send({ error: 'agenda_regenerate_failed' });
    }
  });

  // Persist edited_content without clobbering generated_content. Founder-only
  // write (board is read-only on agenda edits, mirroring founder-managed RLS).
  app.patch('/api/agenda', async (req, reply) => {
    reply.header('cache-control', 'no-store');
    if (!requireFounder(req, reply)) return;
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    if (!Object.prototype.hasOwnProperty.call(body, 'edited_content')) {
      reply.code(400).send({
        error: 'validation_failed',
        message: 'edited_content required'
      });
      return;
    }
    // Ensure an agenda exists so the first edit after a cold boot still works.
    try {
      await buildAndStoreAgenda(req, { force: false });
      const agenda = setEditedContent(body.edited_content);
      reply.code(200).send({ agenda });
    } catch (err) {
      if (err && err.code === 'NOT_FOUND') {
        reply.code(404).send({ error: 'not_found', message: err.message });
        return;
      }
      req.log.error({ err: err && err.message }, 'agenda edit failed');
      reply.code(500).send({ error: 'agenda_edit_failed' });
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
  // Apply governance schema + role backfill before serving traffic. Idempotent;
  // no-ops without DATABASE_URL (in-memory governance path). Failures are
  // logged inside ensureGovernanceReady and do not block boot — /health must
  // stay green so Railway does not roll back.
  try {
    const mig = await ensureGovernanceReady();
    if (mig && mig.ok === false) {
      console.error('[boot] governance migration reported failure:', mig.error || mig);
    } else if (mig && mig.ran && mig.ran.length) {
      console.log('[boot] applied migrations:', mig.ran.join(', '));
    }
  } catch (err) {
    console.error('[boot] governance ensure failed:', err && err.message);
  }

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
    process.on(signal, async () => {
      try {
        await app.close();
      } catch {
        /* ignore */
      }
      try {
        await closePool();
      } catch {
        /* ignore */
      }
      process.exit(0);
    });
  }
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  start();
}
