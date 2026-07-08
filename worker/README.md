# NStatus Worker — Cloudflare Worker Backend

The serverless backend for NStatus. Runs entirely on Cloudflare Workers with D1, R2, and Durable Objects.

## Quick Deploy

```bash
cd worker
bash deploy.sh
```

## Architecture

```
src/
├── index.js           # Entry point — fetch() handler + scheduled() cron
├── routes.js          # API route dispatching
├── probe.js           # HTTP/TCP probe engine, region proxy via DO
├── admin.js           # Target CRUD, schema migration, install commands, archive
├── auth.js            # Token auth, scoped per-VPS tokens, constant-time compare
├── admin_session.js   # Cookie sessions, TOTP-aware login flow
├── admin_ui.js        # Admin panel HTML server
├── admin_assets.js    # Admin panel inline CSS/JS
├── alerts.js          # Telegram alerts: offline, resource, expiry, traffic
├── metrics.js         # Agent telemetry ingestion (D1 + R2)
├── status.js          # Public status API + R2 snapshots
├── storage.js         # R2 read/write with D1-backed locking
├── traffic.js         # Per-VPS traffic accounting
├── ratelimit.js       # In-memory + D1 rate limiting
├── totp.js            # TOTP 2FA (RFC 6238) with Web Crypto
├── utils.js           # Shared utilities
└── version.js         # Version string
```

## Manual Setup

### 1. Create D1 Database

```bash
npx wrangler d1 create nstatus-db
# Copy the database_id into wrangler.toml
```

### 2. Create R2 Bucket

```bash
npx wrangler r2 bucket create nstatus-archive
```

### 3. Configure Environment Variables

Edit `wrangler.toml`:

```toml
[vars]
PUBLIC_WORKER_URL = "https://your-worker.your-subdomain.workers.dev"  # REQUIRED
TIMEZONE_OFFSET_MINUTES = "480"  # UTC+8
```

### 4. Set Secrets

```bash
npx wrangler secret put ADMIN_TOKEN       # Required — admin login
npx wrangler secret put AGENT_TOKEN       # Required — agent auth base
npx wrangler secret put TOTP_ENCRYPTION_KEY  # Optional — for 2FA
npx wrangler secret put TELEGRAM_BOT_TOKEN   # Optional — for alerts
```

### 5. Deploy

```bash
npx wrangler deploy
```

## Cron Schedule

The Worker runs every 5 minutes (`*/5 * * * *`) and executes:

1. Schema migration (idempotent)
2. Cleanup volatile history
3. Probe all due targets
4. Evaluate alerts
5. Write status snapshot to R2
6. Cleanup rate limit entries
7. Hourly: bucket maintenance, R2 metrics cleanup
8. Daily: archive summaries to R2

## Key Design Decisions

- **R2 for high-frequency data**: Agent metrics time-series and check history go to R2 to stay within D1 row limits
- **D1 for relational state**: Targets, latest status, incidents, traffic, sessions, alerts
- **Scoped tokens**: Each VPS gets a unique token derived from `AGENT_TOKEN + agent_id` — no per-token storage needed
- **Idempotent schema**: Migrations catch "duplicate column" errors gracefully
- **Durable Objects for region probes**: Optional geo-distributed probing via DO instances

## Environment Variables

See the main [README](../README.md#worker-environment-variables) for the full list.

## Testing

```bash
# Unit tests
cd worker/tests
node utils.test.mjs
```

## Adding New Routes

1. Add handler in the appropriate `src/` file
2. Register in `src/routes.js`
3. Add auth middleware if needed (`requireAdmin`, `requireAgent`, etc.)

## Cache Strategy

- `/api/status`: cached (configurable TTL), with R2 snapshot fallback
- `/api/checks`: cached per target
- `/api/agent/metrics`: cached per agent
- Write endpoints: not cached
