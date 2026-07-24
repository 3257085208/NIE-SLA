# 07 Configuration

## Worker Variables

| Variable | Default | Description |
| --- | --- | --- |
| `PUBLIC_SITE_NAME` | `NStatus` | Public site name |
| `PUBLIC_WORKER_URL` | empty | Public Worker URL |
| `PUBLIC_AGENT_INSTALL_BASE` | auto | Installer/download base |
| `ALLOWED_ORIGIN` | empty | CORS origin |
| `DEVELOPER_API_ORIGINS` | empty | Exact comma-separated browser origins for read-only `/api/v1`; no wildcard |
| `TIMEZONE_OFFSET_MINUTES` | `480` | Timezone offset |
| `CONCURRENCY` | `8` | Probe concurrency |
| `MAX_TARGETS_PER_RUN` | `60` | Cron probe cap |
| `STATUS_CACHE_TTL` | `45` | Status cache seconds |
| `AGENT_OFFLINE_AFTER_SEC` | `900` | Heartbeat gap before an Agent is considered offline |
| `AGENT_AVAILABILITY_RETENTION_DAYS` | `90` | Daily Agent heartbeat availability retention, bounded to 30-180 days |
| `AGENT_METRICS_TO_D1` | `false` | Store metric history in D1 |
| `AGENT_PINGS_TO_D1` | `false` | Store ping history in D1 |
| `AGENT_METRICS_R2_RETENTION_HOURS` | `72` | R2 telemetry retention |
| `RATE_LIMIT_D1` | `true` | Durable D1 rate limits |
| `TELEGRAM_CHAT_ID` | empty | Optional Telegram chat id |

## Secrets

| Secret | Purpose |
| --- | --- |
| `ADMIN_TOKEN` | Admin authentication |
| `AGENT_TOKEN` | Agent authentication |
| `TOTP_ENCRYPTION_KEY` | TOTP secret encryption |
| `TELEGRAM_BOT_TOKEN` | Optional Telegram bot token |
| `ALERT_ENCRYPTION_KEY` | Optional Telegram token encryption key for D1 storage; falls back to `TOTP_ENCRYPTION_KEY` |

## Agent Environment

| Variable | Description |
| --- | --- |
| `NSTATUS_API_BASE` | Worker API base |
| `NSTATUS_AGENT_TOKEN` | Agent token |
| `NSTATUS_AGENT_ID` | Target ID |
| `NSTATUS_AGENT_LABEL` | Display label |
| `NSTATUS_INTERVAL_SEC` | Upload interval |
| `NSTATUS_SAMPLE_SEC` | Local sample interval |
| `NSTATUS_PING_SEC` | Ping interval |
| `NSTATUS_PING_TARGET_REFRESH_SEC` | Managed Ping target refresh interval; default 600 seconds |
| `NSTATUS_PING_TARGETS` | Ping target ids or `*` |
