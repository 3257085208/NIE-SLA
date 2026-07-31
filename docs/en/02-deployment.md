# Deployment

## New installations

1. Click **Deploy to Cloudflare** in the public repository.
2. Authorize GitHub and Cloudflare.
3. Set `ADMIN_USERNAME`, `ADMIN_PASSWORD`, `ADMIN_PATH`, and a random `TOTP_ENCRYPTION_KEY` of at least 32 characters.
4. Wait for the Worker build.
5. Open `Worker URL + ADMIN_PATH`.
6. Add a VPS and run its generated Agent command.

The deployment includes Static Assets, D1, R2, Durable Objects, and Cron. No Pages project is required.

Agent tokens are generated per node. Keep the encryption key independent and stable when changing the Admin password. TOTP is disabled by default.

## Migration from Pages + Worker

Export both portable and protected backups first. Prefer binding the original D1 and R2 to the new Worker. Preserve the Agent API hostname, Target IDs, credentials, and encryption material. Move the public site hostname only after the API, admin login, Cron, Agent reports, and notifications are verified.

## Verification

```bash
curl -fsSL https://status.example.com/api/health
curl -fsSL https://status.example.com/bin/VERSION
curl -fsSL https://status.example.com/bin/SHA256SUMS
```
