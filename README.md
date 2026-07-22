# ig-board

## Vision

a bi platform to help the board of the image group (promotional products company) manage the organization from teh top down.

## Boardroom schema

The Supabase-compatible Postgres schema, RLS, and idempotent seed live under
[`db/`](db/); see [`docs/SCHEMA.md`](docs/SCHEMA.md) for the full write-up.

- `npm run migrate` — apply migrations `db/migrations/*.sql`
- `npm run seed` — idempotent seed (5 layers, 25 KPIs)
- `npm run probe` — RLS probes (anon zero-rows, board write-blocks, audit immutability)
- `npm run seed:twice` — idempotency proof
- `npm start` — API serving `GET /version` (deployed git SHA); best-effort migrate+seed on boot

Captured proofs are in [`transcripts/`](transcripts/).

## Working with Ratchet

This folder is a Ratchet project workspace on the control plane.
Missions target this folder; metadata lives in `project.json`.

- Open **Projects** in Composer to edit live URL, git repo, Railway name.
- Use **Build** with this folder selected to enqueue missions.
