# Live verify evidence — admin nav / logout / jasonharper admin

- Collected: 2026-07-25T20:50:18.196879+00:00
- Live: https://ig-board-production.up.railway.app
- SHA: `bf52142e2ad59c83a7284e74a51f22442f0ebd69`

## Pass criteria (API / server-side)

| Check | Result |
|-------|--------|
| jason@jasonharper.com role admin + access_admin_area | **PASS** (`role=admin`) |
| Admin can GET /api/admin/users | **PASS** |
| Employee GET /api/admin/users | **PASS** (403) |
| Employee GET /admin | **PASS** (HTTP/2 403 ) |
| Logout then /me | see logout-*.txt |
| GET /version SHA | `bf52142e2ad59c83a7284e74a51f22442f0ebd69` |
| GET /health | 200 |

## Role snapshot (admin list)

```json
{
  "jason@jasonharper.com": "admin",
  "jason@readysignal.com": "admin",
  "ratchet-admin@boardroom.test": "admin",
  "ratchet-employee@boardroom.test": "employee"
}
```

## Client Admin nav note

`AdminNav` is client-rendered from `/me` capabilities (`access_admin_area`). Server gates for `/admin` and `/api/admin/*` are proven above for admin vs employee — that is the security-critical surface.

Artifacts in this directory are the operator evidence pack for mission `ig-board-admin-nav-verify`.
