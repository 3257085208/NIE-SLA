# 10 Security and Free Tier

## Security

Use a strong admin password and an independent `TOTP_ENCRYPTION_KEY`, enable TOTP, protect generated install commands, keep IP masking enabled for public pages, and avoid putting passwords, sessions, or secrets in command arguments and public repositories. New deployments generate a random token for each Agent automatically; D1 authenticates with token hashes and encrypts the recoverable copies used to display install commands again.

Extension uploads use browser-to-Worker SHA-256 verification, strict ZIP/path/size validation, staged R2 revisions with failure cleanup, and sandboxed HTML/SVG responses. Server-side marketplace URL imports remain disabled until public-HTTPS-only resolution, IP pinning, redirect-by-redirect validation, response limits, and mandatory catalog hashes can all fail closed. Treat every third-party package as a supply-chain input and verify its source tag, license, explicit file list, and published digest before enabling it. See [Extensions and Developer API](13-extensions-developer-guide.md).

## Cloudflare Free Tier

With 50 Agents reporting every 300 seconds and R2-primary history, Worker requests remain below the 100k/day free limit and D1 writes usually remain well below the daily limit. Avoid enabling `AGENT_METRICS_TO_D1` and `AGENT_PINGS_TO_D1` for large fleets unless you have calculated the write volume.

## Alert Cost

Telegram and email alerts add only small D1 reads/writes during cron runs and external HTTP requests when messages are sent. They do not double R2 history usage.

## WebSocket Tradeoff

WebSocket can improve realtime precision, but it introduces connection state and likely Durable Object complexity. Periodic HTTP is safer for this project's free-tier target.
