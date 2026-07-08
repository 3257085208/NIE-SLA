# Deployment Guide

## Prerequisites

- Cloudflare account (free tier)
- Node.js 18+
- Domain (optional, workers.dev subdomain works)

## Step 1: Create Resources

```bash
cd worker

# Create D1 database
npx wrangler d1 create nstatus-db
# Copy database_id output → wrangler.toml [[d1_databases]]

# Create R2 bucket
npx wrangler r2 bucket create nstatus-archive

# Set secrets
npx wrangler secret put ADMIN_TOKEN
npx wrangler secret put AGENT_TOKEN
npx wrangler secret put TOTP_ENCRYPTION_KEY

# Optional: set CORS origin for frontend
# Add to wrangler.toml [vars]:
# ALLOWED_ORIGIN = "https://your-frontend.pages.dev"
```

## Step 2: Deploy Worker

```bash
npx wrangler deploy
```

Verify: `curl https://your-worker.workers.dev/` → `{"ok":true,"name":"NStatus","version":"1.0.0"}`

## Step 3: Deploy Frontend

```bash
cd frontend
echo "window.NSTATUS_API_BASE = 'https://your-worker.workers.dev';" > config.js
npx wrangler pages deploy ./ --project-name=nstatus
```

## Step 4: Add Targets

```bash
# HTTP website
curl -X POST https://your-worker.workers.dev/api/targets \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"My Site","group_name":"Web","type":"http","url":"https://example.com","expected_status":"200,301,302"}'

# TCP port
curl -X POST https://your-worker.workers.dev/api/targets \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"My VPS","group_name":"VPS","type":"tcp","target_host":"1.2.3.4","target_port":22,"probe_region":"apac"}'
```

## Step 5: Install Agent

```bash
curl -fsSL https://your-agent-deploy.pages.dev/install.sh | sudo sh
```

## TCP Ping Targets

```sql
-- In D1 console, add ping targets for agents:
INSERT INTO ping_targets (id, name, target, enabled) VALUES
('ping-cf', 'Cloudflare DNS', '1.1.1.1:53', 1),
('ping-google', 'Google DNS', '8.8.8.8:53', 1);
```

Then on VPS: `cftz set` → select ping targets.
