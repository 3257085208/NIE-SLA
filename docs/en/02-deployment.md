# 02 Deployment

## Deploy to Cloudflare

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/3257085208/NIE-SLA)

The official Deploy Button forks the repository, provisions D1 and R2, binds the Durable Object, configures the cron trigger, and serves the API plus frontend from one Worker. Set unique random values of at least 32 bytes for `ADMIN_TOKEN`, `AGENT_TOKEN`, and `TOTP_ENCRYPTION_KEY` in the deployment form. Cloudflare Deploy Buttons do not support Pages, so this path uses Worker Static Assets; the separate Worker + Pages process remains available below.

## Prerequisites

- A Cloudflare account.
- Node.js 18 or newer.
- Wrangler via `npx wrangler` or a global install.
- A custom domain is optional.

## Recommended Script

```bash
cd worker
bash deploy.sh
```

The script creates or reuses D1/R2 resources, writes secrets, generates `wrangler.toml`, deploys the Worker, writes frontend config, and deploys Pages.

## Manual Worker Deployment

```bash
cd worker
npx wrangler d1 create nstatus-db
npx wrangler r2 bucket create nstatus-archive
npx wrangler secret put ADMIN_TOKEN
npx wrangler secret put AGENT_TOKEN
npx wrangler secret put TOTP_ENCRYPTION_KEY
npx wrangler deploy
```

Copy the D1 database id into `worker/wrangler.toml`.

## Manual Pages Deployment

```bash
cd frontend
cat > config.js <<'EOF'
window.NSTATUS_API_BASE = 'https://your-worker.example.workers.dev';
EOF
npx wrangler pages deploy ./ --project-name=nstatus
```

## Custom Domains

Recommended layout: Worker API on `https://nstatus-api.example.com`, Pages frontend on `https://status.example.com`, and Agent download base on the Pages frontend domain.

When frontend and Worker are cross-origin, set `ALLOWED_ORIGIN`, `PUBLIC_WORKER_URL`, and `PUBLIC_AGENT_INSTALL_BASE` in `wrangler.toml`.

## Verification

```bash
curl https://your-worker.example.com/
```

Expected response includes `"ok":true`. Then open `https://your-frontend/admin.html` and log in with `ADMIN_TOKEN`.
