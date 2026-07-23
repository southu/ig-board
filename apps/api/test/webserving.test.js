// Integration tests for the static web-export serving surface (src/server.js).
//
// When the Next.js export is present, the API serves it from the same service so
// a single live_url satisfies every acceptance check. These lock in the exact
// routing the live tester exercises against Railway — the behaviour that has no
// coverage in server.test.js (which runs without a web export):
//   - GET /            -> 200 index.html (app shell)
//   - GET /login       -> 200 login.html (clean-URL -> <slug>.html mapping)
//   - GET /scorecard   -> 200 scorecard.html (a second protected route)
//   - GET /signup      -> 404 (invite-only: no registration form served)
//   - GET /register    -> 404
//   - GET /health      -> 200 even with the export mounted (API regression)
//
// A temporary directory stands in for apps/web/out; WEB_ROOT points the server
// at it so the test never depends on a prior `next build`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../src/server.js';

// A minimal export fixture: enough files to prove index serving, clean-URL
// mapping, and the 404 fallback for routes that don't exist (no /signup page).
const webRoot = mkdtempSync(join(tmpdir(), 'ig-board-web-'));
writeFileSync(join(webRoot, 'index.html'), '<!doctype html><title>home</title>APP_SHELL');
writeFileSync(join(webRoot, 'login.html'), '<!doctype html><title>login</title>LOGIN_FORM');
writeFileSync(join(webRoot, 'scorecard.html'), '<!doctype html><title>scorecard</title>SCORECARD');
writeFileSync(join(webRoot, '404.html'), '<!doctype html><title>404</title>NOT_FOUND_PAGE');

// Build the app against the fixture export. WEB_ROOT wins over path probing, so
// buildApp() mounts fastify-static + the clean-URL notFoundHandler.
async function makeApp() {
  const prev = process.env.WEB_ROOT;
  process.env.WEB_ROOT = webRoot;
  const app = buildApp({ logger: false });
  await app.ready();
  // Restore immediately: the root was captured at buildApp() time.
  if (prev === undefined) delete process.env.WEB_ROOT;
  else process.env.WEB_ROOT = prev;
  return app;
}

test('GET / serves the exported app shell (index.html)', async (t) => {
  const app = await makeApp();
  t.after(() => app.close());
  const res = await app.inject({ method: 'GET', url: '/' });
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-type'], /text\/html/);
  assert.match(res.payload, /APP_SHELL/);
});

test('GET /login maps the clean URL to login.html with 200', async (t) => {
  const app = await makeApp();
  t.after(() => app.close());
  const res = await app.inject({ method: 'GET', url: '/login' });
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-type'], /text\/html/);
  assert.match(res.payload, /LOGIN_FORM/);
});

test('GET /scorecard serves a second protected route via clean URL', async (t) => {
  const app = await makeApp();
  t.after(() => app.close());
  const res = await app.inject({ method: 'GET', url: '/scorecard' });
  assert.equal(res.statusCode, 200);
  assert.match(res.payload, /SCORECARD/);
});

// Invite-only: there is no /signup or /register page in the export, so these
// must NOT serve a registration form — the server returns the 404 page.
for (const route of ['/signup', '/register']) {
  test(`GET ${route} returns 404 (no self-signup route)`, async (t) => {
    const app = await makeApp();
    t.after(() => app.close());
    const res = await app.inject({ method: 'GET', url: route });
    assert.equal(res.statusCode, 404);
    assert.doesNotMatch(res.payload, /LOGIN_FORM|APP_SHELL/);
  });
}

test('a non-GET request to an unknown route returns a 404 JSON, not HTML', async (t) => {
  const app = await makeApp();
  t.after(() => app.close());
  const res = await app.inject({ method: 'POST', url: '/signup' });
  assert.equal(res.statusCode, 404);
  assert.equal(res.json().error, 'not_found');
});

test('GET /health stays 200 with the web export mounted (API regression)', async (t) => {
  const app = await makeApp();
  t.after(() => app.close());
  const res = await app.inject({ method: 'GET', url: '/health' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().status, 'ok');
});
