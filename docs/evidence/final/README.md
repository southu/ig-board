# Final evidence pack — Boardroom (ig-board)

Universal regression pack against production Railway
(`https://ig-board-production.up.railway.app`). Non-secret only: no tokens,
service-role keys, or Anthropic keys.

## Contents

| Path | Covers |
| --- | --- |
| `00-summary.json` | Aggregate acceptance checklist |
| `phase{1,2,3,4}-playwright.json` | Live Playwright suite results (all green) |
| `screenshots/` | Four-way dashboard + layer (light/dark × desktop/375) |
| `aa-report.json` | axe WCAG 2 AA contrast (0 violations light+dark) |
| `analysis-sample.md` / `.json` | Five-section Independent Analysis (AI-generated) |
| `audit-definition-changed-sample.json` | audit_log rows for definition edits + 90-day flag |
| `seed-rls-verify.txt` | Seed twice idempotent + RLS guarantees (local PG16) |
| `anon-zero-rows.txt` | Anon Supabase zero-row / deny probe |
| `board-kpi-denials.txt` | Board write denials |
| `audit-log-immutable.txt` | audit_log no UPDATE/DELETE |
| `memo-storage.txt` | Public path denied; signed URL 3600s |
| `no-self-signup.txt` | Invite-only; no self-signup routes |
| `client-secret-scan.txt` | No sk-ant / service-role in client assets |
| `security-summary.json` | Aggregate security probe (49/49) |
| `theme-integrity.txt` | No-flash pre-paint, persist, system default, tokens |
| `dashboard-smoke.txt` | Authenticated founder KPI content smoke |

## Regenerating

```bash
LIVE_URL=https://ig-board-production.up.railway.app npm run test:e2e:live
LIVE_URL=… npm run test:security:live
DATABASE_URL=postgres://… bash supabase/verify.sh
```

Never commit secrets. Never touch `version.txt`.
