# NIE-SLA

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/3257085208/NIE-SLA)

NIE-SLA is an open-source, Cloudflare-native status page and VPS telemetry system built with Workers, D1, R2, Pages, Durable Objects, a Rust Agent, and optional external Latency Agents.

The Chinese [README](README.md) and [documentation index](README.md#文档导航) are the primary, most detailed manuals. English component guides are available under [`docs/en`](docs/en/01-architecture.md).

## Highlights

- HTTP/TCP availability checks from Cloudflare.
- A single-binary Rust VPS Agent with no Python, Node.js, Docker, or inbound management port requirement.
- One-second local VPS metric sampling with durable batching and retry.
- CPU, GPU, motherboard, disk, and chipset temperatures when the host exposes reliable sensors.
- Agent-side TCP Ping history.
- Multi-network TCP latency from lightweight external Linux nodes.
- D1 for relational state and R2 for raw telemetry and snapshots.
- Public status page plus Token/TOTP protected administration.
- Telegram alerts, traffic quotas, billing metadata, NodeQuality reports, and custom ordering.
- Uploadable theme and plugin ZIP packages, documented manifests, and a constrained public developer API.
- Scoped per-node Agent tokens and SHA-256 verified updates.
- A documented free-tier capacity model for 50, 100-class, and 200-node scenarios instead of an unexplained node-limit claim.
- Multi-architecture Linux and Windows releases from GitHub Actions.

"Rust Agent" does not mean the entire stack is Rust: the Cloudflare Worker and frontend use JavaScript, while the production VPS telemetry Agent is the native Rust component.

## Where It Fits

This comparison describes product categories rather than claiming that every project has the same feature set. The Cloudflare-native category was checked against public project READMEs and deployment guides in July 2026; individual project names are intentionally omitted.

| Area | NIE-SLA | Typical Cloudflare uptime/status tool | Traditional centralized VPS monitor |
| --- | --- | --- | --- |
| Control plane | Workers, D1, R2, Pages, and Durable Objects | Usually Workers plus D1/KV and Pages | A self-hosted server, database, and web port |
| Availability | Cloudflare HTTP/TCP with optional regional execution | Usually strong HTTP/TCP status and alerting | Runs from the central server or agents |
| Host telemetry | One-second Rust Agent sampling, batching, and durable retry | Usually URL/port focused without a full host Agent | A core strength, often with richer live management |
| Hardware temperatures | CPU/GPU/board/disk/chipset when sensors are reliable | Usually unavailable | Depends on the Agent and platform |
| Network viewpoints | Cloudflare checks, per-VPS TCP Ping, and external Latency Agents | Usually Cloudflare-region viewpoints | Usually Agent Ping without an inherent CF-edge viewpoint |
| High-frequency history | D1 for state; R2 for raw metrics, Ping, and snapshots | Commonly D1/KV check history | Stored in the operator's database |
| Extensibility | Uploaded theme/plugin ZIPs, manifests, sandboxing, and public APIs | Configuration, source customization, or built-in themes varies | Theme/plugin maturity varies by project |
| Remote administration | Deliberately excludes web shells and arbitrary command execution | Usually uptime-focused | Often stronger terminals, jobs, and command execution |
| Capacity model | Published request, D1, and R2 math with explicit assumptions | Commonly a monitor-count or free-tier estimate | Determined by server, database, and bandwidth sizing |

Choose NIE-SLA when you want a Cloudflare-hosted public status page and serious VPS telemetry without operating or exposing a central management server. A dedicated uptime tool can be simpler for website-only checks, certificate/domain expiry, or broad notification integrations. A traditional centralized monitor remains a better fit for web terminals, scheduled jobs, remote commands, or richer live operations. These categories can also coexist.

## Quick Start

The Deploy to Cloudflare button provisions the Worker, D1, R2, Durable Object, cron trigger, and same-origin static frontend. The setup form only requires three unique random secrets: `ADMIN_TOKEN`, `AGENT_TOKEN`, and `TOTP_ENCRYPTION_KEY`.

For a separate Worker + Pages deployment:

```bash
git clone https://github.com/3257085208/NIE-SLA.git
cd NIE-SLA/worker
bash deploy.sh
```

The deployment script creates or reuses D1/R2, downloads and verifies Agent release assets, configures Worker secrets, deploys the Worker, and publishes the Pages frontend. Never commit the generated `worker/wrangler.local.toml`, `.dev.vars`, `.env`, tokens, production data, or private infrastructure identifiers.

## Validation

```bash
bash test.sh
```

See [deployment](docs/en/02-deployment.md), [Agent](docs/en/04-agent.md), [external Latency Agents](docs/en/12-external-latency-agents.md), [operations](docs/en/09-operations.md), and [security](docs/en/10-security-free-tier.md) for English references.

Licensed under the [MIT License](LICENSE).
