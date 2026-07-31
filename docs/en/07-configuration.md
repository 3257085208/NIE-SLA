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
| `MAX_TARGETS_PER_RUN` | `20` | Persistent probes per minute; the default covers 100 targets in five minutes |
| `FAST_STATUS_ENABLED` | `true` | Enable lightweight R2 current-status probes |
| `FAST_STATUS_INTERVAL_SEC` | `60` | Current-status interval, bounded to 60-300 seconds |
| `FAST_STATUS_MAX_TARGETS` | `50` | Maximum fast targets when no persistent probes are due |
| `STATUS_SNAPSHOT_EVERY_SEC` | `300` | Full R2 snapshot interval; minute-level current state is still overlaid in responses |
| `AGENT_AUTO_UPDATE_DEFAULT` | `true` | Default verified Agent update policy until an administrator explicitly changes it in D1 |
| `STATUS_CACHE_TTL` | `20` | Status cache seconds |
| `AGENT_OFFLINE_AFTER_SEC` | `900` | Heartbeat gap before an Agent is considered offline |
| `AGENT_AVAILABILITY_RETENTION_DAYS` | `90` | Daily Agent heartbeat availability retention, bounded to 30-180 days |
| `AGENT_METRICS_TO_D1` | `false` | Store metric history in D1 |
| `AGENT_PINGS_TO_D1` | `false` | Store ping history in D1 |
| `AGENT_METRICS_R2_RETENTION_HOURS` | `72` | R2 telemetry retention |
| `AGENT_CREDENTIAL_TOUCH_SEC` | `21600` | Minimum interval between per-node credential activity writes |
| `TRAFFIC_PERSIST_INTERVAL_SEC` | `1800` | Maximum traffic-ledger persistence interval; responses include pending counter deltas |
| `RATE_LIMIT_D1` | `true` | Durable D1 rate limits |
| `TELEGRAM_CHAT_ID` | empty | Optional Telegram chat id |
| `GITHUB_OAUTH_CLIENT_ID` | empty | Optional GitHub OAuth client id |
| `GITHUB_OAUTH_ALLOWED_USERS` | empty | Comma-separated GitHub username allowlist |
| `GITHUB_OAUTH_CALLBACK_ORIGIN` | current API origin | Optional fixed HTTPS origin for the OAuth callback |
| `ALERT_EMAIL_FROM` | empty | Resend sender |
| `ALERT_EMAIL_TO` | empty | Comma-separated email recipients |

The `TELEMETRY_BUFFER` Durable Object binding is required by the default free-tier architecture. It keeps the five-minute upload interval, serves active-hour Metrics/Ping samples directly, and writes one merged R2 object per completed Agent hour. Without this binding the Worker uses the compatible per-report R2 fallback, which is not suitable for the 100-node free-tier budget.

## Secrets

| Secret | Purpose |
| --- | --- |
| `ADMIN_PASSWORD` | Admin password; existing deployments temporarily fall back to `ADMIN_TOKEN` |
| `TOTP_ENCRYPTION_KEY` | Required for new deployments; stable long-term key for TOTP, recoverable per-node Agent tokens, and default Admin-stored secrets |
| `PREVIOUS_ENCRYPTION_KEY` | Optional only during key rotation; remove it after the Admin migration check succeeds |
| `AGENT_TOKEN` | Legacy global/scoped Agent authentication compatibility; omit on new deployments |
| `TELEGRAM_BOT_TOKEN` | Optional Telegram bot token |
| `RESEND_API_KEY` | Optional Resend email API key |
| `GITHUB_OAUTH_CLIENT_SECRET` | Optional GitHub OAuth secret |
| `ALERT_ENCRYPTION_KEY` | Optional independent alert key; falls back to `TOTP_ENCRYPTION_KEY`; the Admin password is read-only legacy migration material |
| `NQ_IMGBED_URL` | Official service only: maintainer image-host endpoint ending in `/upload`; ordinary deployments cannot override the fixed broker with it |
| `NQ_IMGBED_TOKEN` | Official service only: maintainer image-host API token with the `upload` permission |
| `NQ_IMGBED_CHANNEL_NAME` | Optional only on the official service when its S3 configuration has several matching channels |
| `NQ_IMGBED_ENCRYPTION_KEY` | Legacy-only key used to decrypt an existing D1 image-host token |
| `NQ_PUBLIC_BROKER_ENABLED` | Official service only; enables the upload endpoint on the maintainer's Worker |

The NodeQuality image path and public-service broker address are compiled into the Worker for all ordinary one-click and manual deployments; users neither need nor can override them through a Worker variable, their own image-host URL or token. The broker accepts only constrained `network`/`route` text and renders SVG server-side, so it is not an arbitrary file-upload API. `NQ_IMGBED_URL`, `NQ_IMGBED_TOKEN`, the optional channel name and the legacy encrypted D1 fallback are honored only by the official Worker with `NQ_PUBLIC_BROKER_ENABLED=true`. That Worker always uploads through `s3` with no folder. Shared credentials are never distributed through source, backups, forks or broker requests.

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
