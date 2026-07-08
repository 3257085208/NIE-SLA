# Configuration Reference

## Worker (wrangler.toml [vars])

| Variable | Default | Description |
|----------|---------|-------------|
| `PUBLIC_SITE_NAME` | `NStatus` | Status page title |
| `PUBLIC_WORKER_URL` | — | Worker public URL (for snapshot self-fetch) |
| `TIMEZONE_OFFSET_MINUTES` | `480` | UTC offset (480 = UTC+8) |
| `ALLOWED_ORIGIN` | `(none)` | CORS origin for frontend (e.g. `https://your.pages.dev`) |
| `CONCURRENCY` | `8` | Concurrent probes per batch |
| `MAX_TARGETS_PER_RUN` | `60` | Max targets per cron run |
| `CHECKS_DEFAULT_LIMIT` | `864` | Default check records per query |
| `CHECKS_WINDOW_HOURS` | `72` | Default check history window |
| `INCIDENTS_TO_D1` | `true` | Store incidents in D1 |
| `PUBLIC_MASK_IPS` | `true` | Mask IP addresses in public API |

## Agent Environment

| Variable | Default | Description |
|----------|---------|-------------|
| `NSTATUS_API_BASE` | — | Worker API URL |
| `NSTATUS_AGENT_TOKEN` | — | Agent secret token |
| `NSTATUS_AGENT_ID` | hostname | VPS target ID |
| `NSTATUS_INTERVAL_SEC` | `300` | Metrics report interval |
| `NSTATUS_PING_TARGETS` | `*` | Comma-separated ping target IDs, `*` = all |
| `NSTATUS_PING_SEC` | `20` | TCP ping interval |
| `NSTATUS_SAMPLE_SEC` | `1` | System sampling interval |
| `NSTATUS_UNLOCK_CHECK_ENABLED` | `1` on Linux | Run IP.Check.Place unlock detection |
| `NSTATUS_UNLOCK_CHECK_SEC` | `300` | Unlock detection interval |
| `NSTATUS_UNLOCK_CHECK_URL` | `https://IP.Check.Place` | Unlock detection script URL |
| `NSTATUS_UNLOCK_CHECK_TIMEOUT_SEC` | `90` | Unlock detection timeout |

## Secrets (wrangler secret put)

| Secret | Used By |
|--------|---------|
| `ADMIN_TOKEN` | Admin API authentication |
| `AGENT_TOKEN` | Agent authentication |
