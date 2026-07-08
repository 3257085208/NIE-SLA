# 01 Architecture

NIE-SLA uses a Cloudflare-hosted control plane and outbound-only VPS agents. The public entry points are the Worker API and the Pages frontend. VPS nodes do not expose inbound ports.

```text
Browser -> Cloudflare Pages -> Cloudflare Worker
                         |-- D1: targets, latest state, incidents, settings, alert state, rate limits
                         |-- R2: snapshots, high-frequency Agent metrics, ping history
                         |-- Durable Objects: optional regional probes
Rust Agent --------------^  outbound HTTPS only
```

## Worker

The Worker provides public APIs, admin APIs, cron scheduling, D1/R2 persistence, Telegram alert evaluation, and per-target install command generation.

## Frontend

The Pages frontend contains the public dashboard, classic and card themes, the admin panel, install scripts, and Agent binaries used by one-line deployment commands.

## Agent

The Rust Agent samples system metrics locally, runs TCP pings, and uploads batches to the Worker. It uses a native Rust HTTPS client at runtime and does not shell out to `curl` or `wget` for API requests.

## Data Flow

1. The admin creates a target.
2. The Agent fetches ping targets and collects metrics.
3. The Agent posts telemetry to `/api/agent/metrics`.
4. The Worker updates latest state in D1, appends history to R2, and accumulates traffic.
5. Cron evaluates offline/resource/expiry/traffic alerts.
6. The public dashboard reads `/api/status`.

## WebSocket Decision

WebSocket is not the default because minute-level heartbeat accuracy is enough for offline alerts, while long-lived Worker/DO connections would add operational and quota complexity. Periodic HTTP reporting keeps Cloudflare usage predictable.
