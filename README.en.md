# NIE-SLA

NIE-SLA is an open-source, Cloudflare-native status page and VPS telemetry system built with Workers, D1, R2, Pages, Durable Objects, a Rust Agent, and optional external Latency Agents.

The Chinese [README](README.md) and [documentation index](README.md#文档导航) are the primary, most detailed manuals. English component guides are available under [`docs/en`](docs/en/01-architecture.md).

## Highlights

- HTTP/TCP availability checks from Cloudflare.
- One-second local VPS metric sampling with durable batching and retry.
- Agent-side TCP Ping history.
- Multi-network TCP latency from lightweight external Linux nodes.
- D1 for relational state and R2 for raw telemetry and snapshots.
- Public status page plus Token/TOTP protected administration.
- Telegram alerts, traffic quotas, billing metadata, custom ordering, and themes.
- Scoped per-node Agent tokens and SHA-256 verified updates.
- Multi-architecture Linux and Windows releases from GitHub Actions.

## Quick Start

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
