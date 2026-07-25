# 07 Configuration

## Worker Variables

| Variable | Default | Description |
| --- | --- | --- |
| `PUBLIC_SITE_NAME` | `NIE-SLA` | Public site name |
| `ADMIN_USERNAME` | required for new deployments | Admin username; legacy deployments fall back to `admin` |
| `ADMIN_PATH` | `/admin` | Required by one-click deployment; manual deployments fall back to `/admin`, and the D1 Admin setting can override it |
| `APP_UPDATE_MANIFEST_URL` | official public manifest | Advanced override for the HTTPS application update manifest used by Admin |
| `PUBLIC_WORKER_URL` | empty | Public Worker URL |
| `PUBLIC_AGENT_INSTALL_BASE` | auto | Installer/download base |
| `ALLOWED_ORIGIN` | empty | CORS origin |
| `DEVELOPER_API_ORIGINS` | empty | Exact comma-separated browser origins for read-only `/api/v1`; no wildcard |
| `TIMEZONE_OFFSET_MINUTES` | `480` | Timezone offset |
| `CONCURRENCY` | `40` | Probe concurrency |
| `MAX_TARGETS_PER_RUN` | `60` | Cron probe cap |
| `FAST_STATUS_ENABLED` | `true` | Enable lightweight R2 current-status probes |
| `FAST_STATUS_INTERVAL_SEC` | `60` | Current-status interval, bounded to 60-300 seconds |
| `FAST_STATUS_MAX_TARGETS` | `50` | Maximum fast targets per cron invocation |
| `STATUS_CACHE_TTL` | `20` | Status cache seconds |
| `AGENT_OFFLINE_AFTER_SEC` | `900` | Heartbeat gap before an Agent is considered offline |
| `AGENT_AVAILABILITY_RETENTION_DAYS` | `90` | Daily Agent heartbeat availability retention, bounded to 30-180 days |
| `AGENT_METRICS_TO_D1` | `false` | Store metric history in D1 |
| `AGENT_PINGS_TO_D1` | `false` | Store ping history in D1 |
| `AGENT_METRICS_R2_RETENTION_HOURS` | `72` | R2 telemetry retention |
| `RATE_LIMIT_D1` | `true` | Durable D1 rate limits |
| `TELEGRAM_CHAT_ID` | empty | Optional Telegram chat id |
| `GITHUB_OAUTH_CLIENT_ID` | empty | Optional GitHub OAuth client id |
| `GITHUB_OAUTH_ALLOWED_USERS` | empty | Comma-separated GitHub username allowlist |
| `GITHUB_OAUTH_CALLBACK_ORIGIN` | current API origin | Optional fixed HTTPS origin for the OAuth callback |
| `ALERT_EMAIL_FROM` | empty | Resend sender |
| `ALERT_EMAIL_TO` | empty | Comma-separated email recipients |

## Secrets

| Secret | Purpose |
| --- | --- |
| `ADMIN_PASSWORD` | Admin password; existing deployments temporarily fall back to `ADMIN_TOKEN` |
| `TOTP_ENCRYPTION_KEY` | Optional dedicated encryption key for TOTP and recoverable per-node Agent tokens; falls back to deployment `ADMIN_PASSWORD` |
| `AGENT_TOKEN` | Legacy global/scoped Agent authentication compatibility; omit on new deployments |
| `TELEGRAM_BOT_TOKEN` | Optional Telegram bot token |
| `RESEND_API_KEY` | Optional Resend email API key |
| `GITHUB_OAUTH_CLIENT_SECRET` | Optional GitHub OAuth secret |
| `ALERT_ENCRYPTION_KEY` | Optional alert secret encryption key for D1 storage; falls back to `TOTP_ENCRYPTION_KEY`, then deployment `ADMIN_PASSWORD` |

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
