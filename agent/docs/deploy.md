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
npx wrangler secret put ADMIN_PASSWORD
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

Verify: `curl https://your-worker.workers.dev/` → `{"ok":true,"name":"NIE-SLA","version":"1.0.0"}`

## Step 3: Deploy Frontend

```bash
cd frontend
echo "window.NSTATUS_API_BASE = 'https://your-worker.workers.dev';" > config.js
npx wrangler pages deploy ./ --project-name=nstatus
```

## Step 4: Add Targets

Open `/admin`, sign in with the configured username and password, add a target, and use its deployment button. The UI obtains an admin Session and never exposes the password to CRUD endpoints.

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
