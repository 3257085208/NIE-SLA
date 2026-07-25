# NIE-SLA

NIE-SLA is a Cloudflare-hosted status page and VPS monitor. The control plane uses Workers, D1, R2, Durable Objects, and static assets. Each VPS runs a native Rust Agent that reports over outbound HTTPS and does not open a management port.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/3257085208/NIE-SLA)

## One-Click Deployment

You do not need Node.js, Wrangler, a database, or a separate control server.

NIE-SLA also supports a separate Pages frontend and Worker API. Because Cloudflare's deploy button only supports Workers applications, the one-click path serves the frontend through Workers Static Assets on the same Worker as the API. No separate Pages project is required; D1, R2, the Durable Object, and the one-minute cron are provisioned with it.

1. Click **Deploy to Cloudflare**.
2. Sign in to GitHub and Cloudflare and follow the authorization screens.
3. Enter an admin username, an admin password, and two independent secrets.
4. Wait for the build, then open the provided `workers.dev` URL.

| Configuration | Purpose |
| --- | --- |
| `ADMIN_USERNAME` | Admin username, normally `admin` |
| `ADMIN_PASSWORD` | Unique admin password with at least 20 characters |
| `AGENT_TOKEN` | Derives a separate credential for each Agent |
| `TOTP_ENCRYPTION_KEY` | Encrypts TOTP secrets |

Use at least 32 random bytes for each value and store them in a password manager.

Open `/admin`, log in with the username and password, add a VPS under **Agents**, and run the generated Linux or Windows command on that machine. The rest of the setup is available in the admin UI.

See [Deploy to Cloudflare](docs/en/02-deployment.md) for the complete browser flow.

## Features

- One-minute current status with five-minute persistent SLA buckets.
- Cloudflare HTTP and TCP checks with optional regional execution.
- Single-binary Rust Agent for Linux and Windows.
- CPU, memory, disk, load, network, IO, connection, process, and thread metrics.
- CPU, GPU, motherboard, disk, and chipset temperatures when sensors are available.
- One-second local sampling with batched uploads and durable retry.
- D1 for configuration and state; R2 for raw metrics, Ping, and snapshots.
- Per-VPS TCP Ping and optional external Latency Agents.
- Traffic quotas, billing metadata, expiry dates, tags, locations, and NodeQuality reports.
- Telegram and Resend email alerts for availability, resources, traffic, and expiry.
- Uploadable theme and plugin ZIP packages.
- Username/password sessions, optional allowlisted GitHub OAuth and TOTP, per-node scoped tokens, and SHA-256 verified updates.

## Monitoring Paths

| Path | Purpose |
| --- | --- |
| Cloudflare HTTP/TCP | Public service reachability |
| Agent heartbeat and metrics | VPS health and system data |
| Agent TCP Ping | Latency from a VPS to managed targets |
| External Latency Agent | Latency from additional networks |

These paths are independent. An online Agent does not guarantee that a public TCP port is reachable from Cloudflare.

## Scope

Dedicated uptime tools are simpler for website-only checks. Traditional centralized monitors are a better fit for web terminals and remote commands. NIE-SLA combines Cloudflare-side availability with VPS telemetry while deliberately excluding web shells and arbitrary command execution.

## Status and SLA Layers

The one-minute cron performs lightweight current-status probes and merges them into one R2 state object. Five-minute D1 buckets remain the source of SLA history and daily availability. This improves status and alert latency without multiplying persistent SLA writes by five.

Admin passwords are accepted only by the login endpoint. Admin APIs use a 24-hour session whose SHA-256 hash is stored in D1. Optional GitHub OAuth requires an explicit username allowlist, short-lived state and one-time tickets, and cannot bypass TOTP.

## Free-Tier Planning

The default five-minute upload mode is comfortable for small installations. Current estimates place the conservative free-tier boundary near 110 VPS nodes, with no more than 80 recommended for long-running deployments without paid capacity. Actual use depends on traffic, retries, Ping targets, and history retention.

## Documentation

- [Deployment](docs/en/02-deployment.md)
- [Admin](docs/en/03-admin.md)
- [Agent](docs/en/04-agent.md)
- [Alerts](docs/en/06-alerts.md)
- [API](docs/en/08-api.md)
- [Operations](docs/en/09-operations.md)
- [External Latency Agents](docs/en/12-external-latency-agents.md)
- [Extensions](docs/en/13-extensions-developer-guide.md)
- [Security](SECURITY.md)

## Validation

```bash
bash test.sh
npm install
npm run check:deploy
```

Licensed under the [MIT License](LICENSE).
