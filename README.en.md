# NIE-SLA

NIE-SLA is a Cloudflare-hosted status page and VPS monitor. The control plane uses Workers, D1, R2, Durable Objects, and static assets. Each VPS runs a native Rust Agent that reports over outbound HTTPS and does not open a management port.

Canonical documentation: [nie-sla.pages.dev](https://nie-sla.pages.dev/)

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/3257085208/NIE-SLA)

## One-Click Deployment

You do not need Node.js, Wrangler, a database, or a separate control server.

NIE-SLA also supports a separate Pages frontend and Worker API. Because Cloudflare's deploy button only supports Workers applications, the one-click path serves the frontend through Workers Static Assets on the same Worker as the API. No separate Pages project is required; D1, R2, the Durable Object, and the one-minute cron are provisioned with it.

1. Click **Deploy to Cloudflare**.
2. Sign in to GitHub and Cloudflare and follow the authorization screens.
3. Enter an admin username, admin password, and admin route.
4. Wait for the build, then open the provided `workers.dev` URL.

| Configuration | Purpose |
| --- | --- |
| `ADMIN_USERNAME` | Admin username, required during deployment |
| `ADMIN_PASSWORD` | At least 9 characters with uppercase, lowercase, number, and special character |
| `ADMIN_PATH` | A 3-64 character admin route such as `/console-7f3a` |

Do not reuse the password. Per-node Agent tokens are generated automatically when an install command is first opened. TOTP is disabled by default and can be enabled after login; a dedicated encryption key remains an advanced optional setting. Internal tuning defaults are fixed in code and do not appear in the deployment form.

Open the configured `ADMIN_PATH`, log in with the username and password, add a VPS under **Agents**, and run the generated Linux or Windows command on that machine. The rest of the setup is available in the admin UI.

See the canonical [Cloudflare Quick Start](https://nie-sla.pages.dev/quickstart/) for the complete browser flow.

## Online Updates

Version `1.0.20` and newer expose **Settings → System update**, including the installed version, latest stable version, publication time, and changelog. Updates run in the deployment repository's GitHub Actions workflow. It accepts only official `app-vX.Y.Z` tags, preserves the existing Cloudflare bindings in `wrangler.jsonc`, and runs the build, full test suite, and Wrangler dry run before pushing. Cloudflare automatically redeploys the verified commit.

The first update requires read/write workflow permissions and a fine-grained GitHub token scoped only to the deployment repository with `Actions: Read and write`. The token is used for that dispatch only and is not stored in D1, Worker variables, or browser storage. Deployments older than `1.0.20` need one manual upstream sync before they can use the update center.

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
- Admin version checks, changelogs, and verified online application updates.
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

- [Deployment](https://nie-sla.pages.dev/quickstart/)
- [API](https://nie-sla.pages.dev/api/)
- [Extensions](https://nie-sla.pages.dev/dev/)
- [Developer Security](https://nie-sla.pages.dev/dev/security/)
- [Security](SECURITY.md)

## Validation

```bash
bash test.sh
npm install
npm run check:deploy
```

Licensed under the [MIT License](LICENSE).
