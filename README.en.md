# NIE-SLA

NIE-SLA is a Cloudflare-native status page and VPS telemetry platform. Application, Worker, and Agent releases share one stable SemVer.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/3257085208/NIE-SLA)

New deployments use one Worker application for Static Assets, API, D1, R2, Durable Objects, and one-minute Cron scheduling. A separate Pages project is not required.

## Quick Start

1. Click **Deploy to Cloudflare**.
2. Authorize GitHub and Cloudflare.
3. Set the admin username, password, and path.
4. Open the deployed Worker and sign in.
5. Add a VPS and run its generated per-node Agent command.

Agent tokens are generated automatically. TOTP is disabled by default.

## Capabilities

- Cloudflare HTTP/TCP availability and SLA history;
- Rust Agent CPU, memory, disk, load, IO, network, process, uptime, and temperature telemetry;
- Cloudflare latency, Agent TCP Ping, and external Latency Agents;
- provider/custom provider, machine type, pricing, expiry, and independent traffic reset day;
- Agent-side IPv4/IPv6 GeoIP through selectable providers;
- Telegram and email alerts with templates;
- portable and password-protected backup/restore;
- versioned public read-only API for alternate frontends.
- integrity-checked CSS themes and sandboxed full-layout Canvas themes.

## Fixed Beta Actions

The admin panel can explicitly request NodeQuality or an IPv4 unlock check on Linux. The main Agent remains unprivileged; a separate root runner accepts only these two action identifiers. No arbitrary command, URL, arguments, stdin, or schedule can be supplied.

The Worker can render selected NodeQuality sections as SVG and upload them through a fixed S3 channel with no folder. Image-host credentials remain in Worker Secrets, and public reports use the same-origin image proxy instead of exposing the upstream host.

## Migration

Existing Pages + Worker installations should reuse their D1, R2, Agent API hostname, Target IDs, scoped credentials, and encryption material. Existing Agents then continue reporting without reconfiguration. Portable backup is a migration fallback; full high-frequency history remains in R2.

## Security

- outbound-only Agents and per-node scoped tokens;
- username/password sessions with optional OAuth allowlist and TOTP;
- checksum-pinned Agent installation and updates;
- no Web Shell or arbitrary scheduled commands;
- administrator-approved theme packages with no-same-origin Canvas isolation;
- no plugin, admin-script, marketplace, or arbitrary extension runtime;
- encrypted sensitive backups and public payload redaction.

## Validation

```bash
bash test.sh
```

## Theme Development

The admin panel accepts SHA-256-verified CSS and Canvas theme ZIPs. See the [Third-Party Theme Specification](docs/en/13-third-party-themes.md) for the manifest, sandbox protocol, responsive requirements, and release checklist. Runnable sources are in `examples/themes/`.

## License

MIT
