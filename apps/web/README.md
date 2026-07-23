# @ig-board/web

Next.js 14 (App Router) Boardroom web app, configured for **static export**
(`output: 'export'`). The export (`apps/web/out`) is served by the `apps/api`
Fastify service on the same Railway deployment, so one live URL covers the whole
app.

- **Invite-only auth** — `/login` is the only public page: a magic-link email
  form (no password, no self-signup/register). A client-side guard
  (`components/AuthGuard.js`) redirects unauthenticated visitors from every other
  route to `/login`.
- **Boardroom theme** — light + dark navy/slate variants via `[data-theme]` on
  `<html>`. An inline pre-hydration head script (authored in `app/layout.js`,
  hoisted to the top of `<head>` by `scripts/hoist-theme-head.mjs`) applies the
  theme from `localStorage`/`prefers-color-scheme` before any bundle runs — no
  flash on hard reload. All colors are CSS variables defined once in
  `app/globals.css`.

```bash
npm run dev --workspace apps/web      # local dev server
npm run build:web                     # static export -> apps/web/out (+ theme hoist)
```

Supabase config for the client is read from `NEXT_PUBLIC_SUPABASE_URL` /
`NEXT_PUBLIC_SUPABASE_ANON_KEY` at build time (the anon key is public; RLS is the
guard). When absent, the app still runs correctly for verification.
