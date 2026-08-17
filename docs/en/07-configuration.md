# Configuration reference

Configuration splits into four groups: Worker vars, Worker secrets, admin D1 settings, and Agent environment variables. Secrets belong in Wrangler Secrets, never in `[vars]`, `.env`, or frontend source.

## Core Worker vars

| Name | Default | Purpose |
| --- | --- | --- |
| `PUBLIC_SITE_NAME` | `NIE-SLA` | public site name |
| `PUBLIC_WORKER_URL` | Worker HTTPS URL | fallback for region/install URLs |
| `TIMEZONE_OFFSET_MINUTES` | `480` | UTC+8; affects daily buckets and archiving |
| `CONCURRENCY` | `40` | targets checked concurrently per run |
| `MAX_TARGETS_PER_RUN` | `20` | persisted checks per minute; 100 targets in 5 minutes by default |
| `FAST_STATUS_ENABLED` | `true` | lightweight current-state probing via R2 |
| `FAST_STATUS_INTERVAL_SEC` | `60` | current-state interval, 60-300 |
| `FAST_STATUS_MAX_TARGETS` | `50` | fast probes per minute without persisted checks, 1-50 |
| `STATUS_SNAPSHOT_EVERY_SEC` | `300` | full R2 snapshot interval |
| `CHECKS_DEFAULT_LIMIT` | `864` | default detail limit |
| `CHECKS_WINDOW_HOURS` | `72` | default detail window |
| `PUBLIC_MASK_IPS` | `true` | mask IPs in public responses |
| `PUBLIC_HIDE_PORTS` | optional | hide ports in public responses |
| `PUBLIC_STATUS_AGENT_DETAILS` | `false` | expose hostname, Agent version, exact capacity/uptime, system and hardware fingerprints, and traffic details; enable only for legacy theme compatibility |
| `PUBLIC_STATUS_UNLOCK_DETAILS` | `false` | expose per-node streaming/IP unlock details |
| `PUBLIC_STATUS_STORAGE_DETAILS` | `false` | expose the D1/R2 storage mode and status snapshot key |
| `INCIDENTS_TO_D1` | `true` | write incidents to D1 |
| `RATE_LIMIT_D1` | `true` | cross-instance rate limiting via D1 |
| `MISSED_WRITE_BACKFILL_MAX_BUCKETS` | `6` | max missed buckets backfilled |
| `ALERT_MAX_MESSAGES_PER_RUN` | `30` | alert cap per run |
| `DEVELOPER_API_ORIGINS` | empty | exact origins allowed to call `/api/v1` from browsers; `*` is ignored |

The three `PUBLIC_STATUS_*_DETAILS` switches default to off. With Agent details disabled, public status and metrics APIs still return CPU, memory, and disk percentages, load, and current receive/transmit rates without exact server fingerprints. Each switch combination uses a separate cache key.

## Metrics and history vars

| Name | Default | Purpose |
| --- | --- | --- |
| `AGENT_OFFLINE_AFTER_SEC` | `900` | offline threshold, 120-3600 |
| `AGENT_AVAILABILITY_RETENTION_DAYS` | `90` | daily availability retention, 30-180 |
| `AGENT_METRICS_RETENTION_HOURS` | `6` | D1 temporary metric retention |
| `AGENT_METRICS_R2_RETENTION_HOURS` | `72` | R2 high-frequency retention |
| `AGENT_METRICS_POINTS_PER_REPORT` | `6` | report sampling control |
| `AGENT_METRICS_TO_D1` | `false` | write high-frequency metrics to D1 (raises write volume) |
| `AGENT_PINGS_TO_D1` | `false` | write ping history to D1 |
| `PING_HISTORY_RETENTION_HOURS` | `6` | D1 ping temporary history |
| `AGENT_CREDENTIAL_TOUCH_SEC` | `21600` | min interval between token last-used writes |
| `TRAFFIC_PERSIST_INTERVAL_SEC` | `1800` | max interval for traffic period rows; page merges unpersisted deltas |

The `TELEMETRY_BUFFER` Durable Object binding is required for the default architecture. It does not change the 5-minute upload interval; the current hour is read from the buffer and merged to R2 at hour boundaries. Removing it falls back to per-upload R2 writes that no longer fit the 100-VPS free-tier budget.

## Install and update vars

| Name | Purpose |
| --- | --- |
| `PUBLIC_AGENT_INSTALL_BASE` | public HTTPS base for install scripts and `bin/` |
| `PUBLIC_AGENT_API_BASE` | Agent reporting API base |
| `AGENT_LATEST_VERSION` | latest version reported by the Worker, e.g. `v1.1.13` |
| `NIE_SLA_SHA256SUMS_SHA256` | SHA-256 of the release manifest; the old `NSTATUS_SHA256SUMS_SHA256` remains readable |
| `AGENT_AUTO_UPDATE_DEFAULT` | default policy when the admin has no setting; `true` by default |
| `AGENT_UPDATE_CHECK_SEC` | suggested policy check interval |
| `AGENT_PING_SEC` | default ping interval in install commands |

## Worker secrets

| Name | Required | Purpose |
| --- | --- | --- |
| `ADMIN_PASSWORD` | new deploys | admin password; old deploys may fall back to `ADMIN_TOKEN` |
| `TOTP_ENCRYPTION_KEY` | new deploys | long-term material for TOTP, recoverable per-node tokens, default notification keys; 32+ chars, independent of the admin password |
| `PREVIOUS_ENCRYPTION_KEY` | during rotation | previous long-term key; remove after migration |
| `AGENT_TOKEN` | legacy only | old global and derived scoped tokens; do not set on new deploys |
| `ALERT_ENCRYPTION_KEY` | optional | independent key for alert credentials; falls back to `TOTP_ENCRYPTION_KEY` |
| `TELEGRAM_BOT_TOKEN` | optional | Telegram bot via environment |
| `RESEND_API_KEY` | optional | Resend email API |
| `GITHUB_OAUTH_CLIENT_SECRET` | optional | GitHub OAuth app secret |
| `NQ_IMGBED_URL` | official service only | image host upload URL, public HTTPS ending in `/upload` |
| `NQ_IMGBED_TOKEN` | official service only | upload-permission API token, readable only by the official broker Worker |
| `NQ_IMGBED_CHANNEL_NAME` | official service optional | fixed channel when several exist |
| `NQ_IMGBED_ENCRYPTION_KEY` | legacy only | decrypts old D1-stored image host tokens |
| `NQ_PUBLIC_BROKER_ENABLED` | official service only | enables the public upload endpoint on the maintainer's production Worker; leave unset elsewhere |

```bash
npx wrangler secret put ADMIN_PASSWORD
npx wrangler secret put TOTP_ENCRYPTION_KEY
npx wrangler secret list
```

The NQ image chain is fixed in code for ordinary deployments; variables, custom image hosts, or tokens cannot override it, and shared tokens never enter source, backups, forks, or broker requests.

## Auth and alert vars

| Name | Default | Purpose |
| --- | --- | --- |
| `ADMIN_USERNAME` | required for new deploys | admin account; falls back to `admin` on old deploys |
| `ADMIN_PATH` | `/admin` | required for one-click deploys; D1 override after login |
| `APP_UPDATE_MANIFEST_URL` | official manifest | override the HTTPS version manifest for app updates |
| `GITHUB_OAUTH_CLIENT_ID` | empty | OAuth Client ID |
| `GITHUB_OAUTH_ALLOWED_USERS` | empty | username allowlist, comma-separated |
| `GITHUB_OAUTH_CALLBACK_ORIGIN` | current API origin | pin the OAuth callback origin |
| `ALERT_EMAIL_FROM` | empty | Resend sender |
| `ALERT_EMAIL_TO` | empty | recipients, comma-separated |
| `ALERT_EMAIL_REPLY_TO` | empty | optional Reply-To |

GitHub login requires Client ID, Client Secret, and a non-empty allowlist; otherwise the button does not render.

## Agent environment

| Name | Default | Purpose |
| --- | --- | --- |
| `NIE_SLA_API_BASE` | none | required HTTPS API |
| `NIE_SLA_AGENT_TOKEN` | none | required scoped token |
| `NIE_SLA_AGENT_ID` | hostname | target ID |
| `NIE_SLA_AGENT_LABEL` | hostname | display name |
| `NIE_SLA_SAMPLE_SEC` | `1` | sampling interval |
| `NIE_SLA_INTERVAL_SEC` | `300` | upload interval |
| `NIE_SLA_PING_SEC` | `20` | ping interval |
| `NIE_SLA_PING_TARGET_REFRESH_SEC` | `600` | ping target refresh, 60-3600 |
| `NIE_SLA_PING_TARGETS` | `*` | managed targets |
| `NIE_SLA_QUEUE_FILE` | platform path | queue file |
| `NIE_SLA_QUEUE_MAX_SAMPLES` | `86400` | queue cap |
| `NIE_SLA_UPDATE_CHECK_SEC` | `3600` | update check interval, 900-86400 |
| `NIE_SLA_ALLOW_INSECURE_HTTP` | off | trusted private-network debugging only |

The corresponding legacy `NSTATUS_*` variables remain readable; the new name wins when both are set.

## Changing configuration

- Vars require a Worker redeploy.
- Secrets require an updated secret binding.
- Admin settings live in D1; no redeploy needed.
- Agent env changes need a service restart.
- Shorter sampling/upload intervals raise CPU, network, and storage pressure.
- Changing the timezone moves daily bucket boundaries; avoid changing it after launch.
