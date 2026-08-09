# Deployment

## One-click deploy

1. Open the public repository README and click **Deploy to Cloudflare**.
2. Authorize GitHub and Cloudflare.
3. Enter the admin username, password, admin path, and a long-term encryption key.
4. Wait for the build, then open the Worker URL.
5. Visit `https://WORKER-URL/admin-path`.
6. Add a VPS and run the generated per-node Agent command.

The build creates or binds Worker Static Assets, D1, R2, Durable Objects, and the one-minute cron. No separate Pages project is required.

Required variables:

| Variable | Requirement |
| --- | --- |
| `ADMIN_USERNAME` | 3-64 allowed characters |
| `ADMIN_PASSWORD` | at least 9 characters with upper/lowercase, digits, and symbols |
| `ADMIN_PATH` | 3-64 letters, digits, hyphens, or underscores; leading slash allowed |
| `TOTP_ENCRYPTION_KEY` | independent random value of at least 32 characters, kept stable |

Agent tokens are generated per node in the admin UI; do not configure a global `AGENT_TOKEN`. TOTP is off by default. The long-term key protects TOTP, recoverable per-node tokens, and notification credentials; do not reuse the admin password.

## Custom domains

Route both the public site domain and the old Agent API domain to the same Worker. If existing Agents use `api.example.com`, keep that hostname working during migration or update every Agent.

## Migration from Pages + Worker

Within the same Cloudflare account, reuse the original D1, R2, and encryption keys:

1. Export a normal backup and an encrypted sensitive backup.
2. Record the D1/R2 bindings, routes, and secrets.
3. Configure Static Assets on the single Worker and bind the original D1/R2.
4. Keep the old Agent API hostname pointed at the new Worker.
5. Verify `/api/health`, the public page, admin UI, cron, and Agent reporting.
6. Switch the site domain from Pages to the Worker.
7. Keep Pages running for at least one full report cycle.

With the original D1, existing Agent IDs and tokens stay valid. Backup restore is a fallback for cross-account moves or mistakes, not the preferred path within one account.

## Updates

The admin "System Update" page shows the current version, latest version, and in-app changelog. The deployment repository's `NIE-SLA Online Update` workflow checks and applies official versions, keeps the deployment's own `wrangler.jsonc`, and stops if other source files were modified.

## Post-deploy checks

```bash
curl -fsSL https://YOUR-DOMAIN/api/health
curl -fsSL https://YOUR-DOMAIN/bin/VERSION
curl -fsSL https://YOUR-DOMAIN/bin/SHA256SUMS
```

Then confirm: admin login works at the right path; new VPSes generate unique install commands; Agents show online with a version; the cron runs every minute; D1/R2 usage stays within free allowances.
