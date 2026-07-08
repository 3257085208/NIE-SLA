<p align="center">
  <img src="https://img.shields.io/github/v/release/3257085208/NIE-SLA?label=Agent%20Version&style=for-the-badge&color=159754" alt="Agent Version">
  <img src="https://img.shields.io/badge/Worker-Compatible-brightgreen?style=for-the-badge&logo=cloudflare&logoColor=white&color=F38020" alt="Worker Compatible">
  <img src="https://img.shields.io/github/languages/top/3257085208/NIE-SLA?style=for-the-badge&color=3572A5" alt="Top Language">
  <img src="https://img.shields.io/github/license/3257085208/NIE-SLA?style=for-the-badge&color=blue" alt="License">
</p>

<p align="center">
  <img src="https://img.shields.io/github/contributors/3257085208/NIE-SLA?style=flat-square&color=orange" alt="Contributors">
  <img src="https://img.shields.io/github/commit-activity/m/3257085208/NIE-SLA?style=flat-square&color=159754" alt="Commit Activity">
  <img src="https://img.shields.io/github/repo-size/3257085208/NIE-SLA?style=flat-square&color=blue" alt="Repo Size">
  <img src="https://img.shields.io/github/stars/3257085208/NIE-SLA?style=social" alt="Stars">
  <img src="https://img.shields.io/github/forks/3257085208/NIE-SLA?style=social" alt="Forks">
</p>

# NIE-SLA — Self-Hosted Status Page & VPS Telemetry

**NStatus** is a self-hosted, Cloudflare-native service monitoring and VPS telemetry system. It monitors HTTP/TCP service availability from the Cloudflare edge, collects detailed VPS system metrics via a Rust agent, tracks per-VPS traffic with billing metadata, performs TCP ping latency checks, and sends Telegram alerts — all running on Cloudflare's **free tier**.

> **No servers required.** Everything runs on Cloudflare Workers, D1, R2, and Pages. Agents only need outbound HTTPS — no inbound ports to open.

---

## Table of Contents

- [Architecture](#architecture)
- [Features](#features)
- [Quick Start](#quick-start)
- [Project Structure](#project-structure)
- [Deployment](#deployment)
  - [1. Deploy Worker (Backend)](#1-deploy-worker-backend)
  - [2. Deploy Frontend (Dashboard)](#2-deploy-frontend-dashboard)
  - [3. Install Agent on VPS](#3-install-agent-on-vps)
- [Configuration](#configuration)
  - [Worker Environment Variables](#worker-environment-variables)
  - [Worker Secrets](#worker-secrets)
  - [Agent Environment Variables](#agent-environment-variables)
- [Agent](#agent)
  - [Rust Agent (Recommended)](#rust-agent-recommended)
  - [Python Agent (OrangePi / Low-Resource)](#python-agent-orangepi--low-resource)
  - [Agent Management CLI](#agent-management-cli)
- [API Reference](#api-reference)
- [Security](#security)
  - [Agent Token Scoping](#agent-token-scoping)
  - [Binary Integrity Verification](#binary-integrity-verification)
  - [Admin Authentication](#admin-authentication)
- [Alerting](#alerting)
- [Traffic Accounting](#traffic-accounting)
- [Development](#development)
  - [Running Tests](#running-tests)
  - [Building the Agent](#building-the-agent)
  - [CI/CD](#cicd)
- [Cloudflare Free Tier Limits](#cloudflare-free-tier-limits)
- [License](#license)

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     Cloudflare Infrastructure                     │
│                                                                   │
│  ┌─────────────┐     ┌──────────────────┐    ┌───────────────┐  │
│  │   Pages      │────▶│   Worker (API)   │────│  D1 Database  │  │
│  │  (Frontend)  │     │                  │    │  (SQL state)  │  │
│  │              │     │  • API routes    │    └───────────────┘  │
│  │ • Status pg  │     │  • Cron probes   │                       │
│  │ • Admin panel│     │  • Alerts        │    ┌───────────────┐  │
│  │ • Installer  │     │  • Agent ingest  │────│   R2 Bucket   │  │
│  │   scripts    │     │  • Schema mgmt   │    │ (History+Snap)│  │
│  └──────┬──────┘     │                  │    └───────────────┘  │
│         │            │  ┌────────────┐  │                       │
│         │ proxied    │  │  Durable    │  │    ┌───────────────┐  │
│         │ via Pages  │  │  Objects    │  │    │  Cache API    │  │
│         │ Functions  │  │ (Region     │  │    │ (Status/Checks│  │
│         │            │  │  Probes)    │──│────│  caching)    │  │
│         │            │  └────────────┘  │    └───────────────┘  │
│         ▼            └────────┬─────────┘                       │
│  ┌──────────┐                 │                                  │
│  │ Telegram │◀────────────────┘                                  │
│  │  Bot API │  (Alerts via HTTP POST)                           │
│  └──────────┘                                                    │
└─────────────────────────────────────────────────────────────────┘
        ▲                              ▲
        │ (HTTPS outbound only)        │ (HTTPS outbound only)
        │                              │
  ┌─────┴──────┐              ┌───────┴────────┐
  │ Rust Agent │              │  External Agent │
  │ (VPS #1)   │              │  (OrangePi, etc)│
  │            │              │                 │
  │ • Metrics  │              │ • HTTP/TCP      │
  │ • TCP Ping │              │   probe results │
  │ • Unlock   │              │                 │
  └────────────┘              └─────────────────┘
```

---

## Features

| Category | Feature |
|---|---|
| **Monitoring** | HTTP/TCP probes from Cloudflare edge, configurable intervals (60s–24h) |
| **Status Page** | Public dashboard with "cards" theme (NodeGet-style) and "classic" theme |
| **Agent** | Rust binary — CPU, memory, disk, load, network rate, disk I/O, connections, TCP ping |
| **Traffic** | Per-VPS monthly traffic accounting with quota alerts (total/tx/rx/max modes) |
| **Billing** | Per-target pricing (USD/CNY), expiry tracking, billing cycle support |
| **Alerts** | Telegram notifications: offline/online, resource thresholds, expiry, traffic quota |
| **Charts** | Interactive latency, CPU, memory, disk, network, ping time-series with Chart.js |
| **2FA** | TOTP-based two-factor authentication for admin panel |
| **Region Probes** | Optional geo-distributed probes via Durable Objects |
| **Security** | Scoped per-VPS agent tokens, binary SHA-256 verification, constant-time auth |
| **Free Tier** | Entire system runs within Cloudflare's generous free limits |

---

## Quick Start

### Prerequisites

- [Cloudflare account](https://dash.cloudflare.com/)
- [Node.js](https://nodejs.org/) ≥ 18
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/) (`npm install -g wrangler`)
- [Rust](https://rustup.rs/) (to build the Agent, optional — pre-built binaries available in releases)

### One-Command Deploy

```bash
git clone https://github.com/3257085208/NIE-SLA.git
cd NIE-SLA/worker
bash deploy.sh
```

The script will guide you through:
1. Wrangler authentication
2. D1 database creation
3. R2 bucket creation
4. Setting ADMIN_TOKEN and AGENT_TOKEN secrets
5. Worker deployment
6. Frontend Pages deployment

After deploying, visit your Pages URL to see the status page and `/admin` to access the admin panel.

---

## Project Structure

```
NIE-SLA/
├── worker/                   # Cloudflare Worker backend
│   ├── src/
│   │   ├── index.js          # Entry point (fetch + cron handlers)
│   │   ├── routes.js         # API route definitions
│   │   ├── probe.js          # HTTP/TCP probe engine
│   │   ├── admin.js          # Target CRUD, schema, install commands
│   │   ├── auth.js           # Token authentication (scoped tokens)
│   │   ├── admin_session.js  # Cookie-based admin sessions + TOTP
│   │   ├── admin_ui.js       # Admin panel HTML server
│   │   ├── admin_assets.js   # Admin panel inline CSS/JS
│   │   ├── alerts.js         # Telegram alerting engine
│   │   ├── metrics.js        # Agent telemetry ingestion/retrieval
│   │   ├── status.js         # Public status API + R2 snapshots
│   │   ├── storage.js        # R2 read/write helpers
│   │   ├── traffic.js        # Per-VPS traffic accounting
│   │   ├── ratelimit.js      # Dual-tier rate limiting
│   │   ├── totp.js           # TOTP 2FA implementation
│   │   ├── utils.js          # Shared utilities
│   │   └── version.js        # Version string
│   ├── tests/
│   │   └── utils.test.mjs    # Unit tests
│   ├── wrangler.toml         # Worker configuration
│   ├── deploy.sh             # Interactive deploy script
│   └── targets-web-d1.sql    # D1 schema bootstrap
│
├── frontend/                 # Cloudflare Pages frontend
│   ├── index.html            # Status page (SPA)
│   ├── app.js                # Dashboard logic (cards/classic themes)
│   ├── config.js             # Runtime API configuration
│   ├── style.css             # Stylesheet (both themes)
│   ├── 404.html              # Custom 404 page
│   ├── functions/            # Pages Functions (API proxy)
│   │   ├── api/[[path]].js   # /api/* → Worker proxy
│   │   └── admin/[[path]].js # /admin/* → Worker proxy
│   ├── js/                   # Frontend modules
│   │   ├── shared/           # Billing, format, HTML, traffic helpers
│   │   └── themes/           # Cards and detail theme modules
│   ├── assets/               # Static assets (logos, flags, OS icons)
│   ├── bin/                  # Pre-built agent binaries (GitHub Releases)
│   │   └── SHA256SUMS        # Binary checksum manifest
│   ├── install.sh            # Linux installer entry
│   ├── install.ps1           # Windows PowerShell installer
│   ├── setup.sh              # Interactive Linux setup
│   ├── quick-install.sh      # Non-interactive installer
│   ├── update.sh             # Agent update script
│   └── cftz                  # Agent management CLI
│
├── agent/                    # Rust Agent + alternative Python agent
│   ├── src/
│   │   └── main.rs           # Rust agent source (single file)
│   ├── Cargo.toml            # Rust package manifest
│   ├── Makefile              # Cross-compilation build targets
│   ├── bin/                  # Build output directory
│   ├── install.sh            # Linux installer entry
│   ├── install.ps1           # Windows PowerShell installer
│   ├── setup.sh              # Interactive Linux setup
│   ├── quick-install.sh      # Non-interactive installer
│   ├── update.sh             # Agent update script
│   ├── cftz                  # Agent management CLI
│   ├── agent_orangepi.py     # Python alternative agent
│   ├── agent_orangepi.env.example  # Python agent env template
│   └── docs/                 # Agent documentation
│
├── docs/                     # General documentation
├── tests/                    # Test configuration
├── cftz                      # Agent management CLI (root copy)
├── test.sh                   # Project-wide test runner
├── package.json              # Node.js ESM declaration
├── .github/workflows/        # GitHub Actions CI/CD
│   └── agent-ci.yml          # Agent build and release workflow
├── README.md                 # You are here
└── README.zh-CN.md           # Chinese version
```

---

## Deployment

### 1. Deploy Worker (Backend)

```bash
cd worker

# Set secrets (required)
npx wrangler secret put ADMIN_TOKEN
npx wrangler secret put AGENT_TOKEN
npx wrangler secret put TOTP_ENCRYPTION_KEY    # optional, for 2FA

# Set required environment variables
# Edit wrangler.toml or use:
npx wrangler deploy --var PUBLIC_WORKER_URL:"https://your-worker.your-subdomain.workers.dev"

# Deploy
npx wrangler deploy
```

### 2. Deploy Frontend (Dashboard)

```bash
cd frontend

# Create config.js with your Worker URL
echo 'window.NSTATUS_CONFIG = { apiBase: "https://your-worker.your-subdomain.workers.dev" };' > config.js

# Deploy to Cloudflare Pages
npx wrangler pages deploy ./ --project-name=nstatus
```

### 3. Install Agent on VPS

**Option A: One-line install from admin panel**

Log into the admin panel at `https://YOUR_PAGES.pages.dev/admin`, go to Targets, click "Install Agent" for any target to get a pre-configured install command.

**Option B: Install from releases**

```bash
# Download and install the pre-built binary
curl -fsSL https://github.com/3257085208/NIE-SLA/releases/latest/download/install.sh | sudo sh

# Interactive setup will prompt for:
#   - API URL: https://your-worker.your-subdomain.workers.dev
#   - Agent Token: (from admin panel)
#   - Target ID: your VPS hostname
```

---

## Configuration

### Worker Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PUBLIC_SITE_NAME` | `"NStatus"` | Status page display name |
| `PUBLIC_WORKER_URL` | `""` | Worker's public URL (required) |
| `TIMEZONE_OFFSET_MINUTES` | `"480"` | Timezone offset in minutes (UTC+8 = 480) |
| `CONCURRENCY` | `"8"` | Max concurrent probes |
| `MAX_TARGETS_PER_RUN` | `"60"` | Max targets probed per cron tick |
| `CHECKS_DEFAULT_LIMIT` | `"864"` | Default check history limit |
| `CHECKS_WINDOW_HOURS` | `"72"` | Default check history window |
| `PUBLIC_MASK_IPS` | `"true"` | Hide IP addresses in public status |
| `AGENT_METRICS_RETENTION_HOURS` | `"6"` | D1 retention for agent metrics |
| `AGENT_METRICS_R2_RETENTION_HOURS` | `"72"` | R2 retention for metrics time-series |
| `ALERT_MAX_MESSAGES_PER_RUN` | `"30"` | Rate limit for alert message sends |
| `RATE_LIMIT_D1` | `"true"` | Enable D1-backed durable rate limiting |

### Worker Secrets

| Secret | Required | Description |
|---|---|---|
| `ADMIN_TOKEN` | Yes | Admin panel login token |
| `AGENT_TOKEN` | Yes | Global agent token (base for per-VPS scoped tokens) |
| `TOTP_ENCRYPTION_KEY` | No | AES-GCM key for TOTP secret encryption |
| `TELEGRAM_BOT_TOKEN` | No | Telegram Bot API token for alerts |

### Agent Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `NSTATUS_API_BASE` | Yes | — | Worker API URL |
| `NSTATUS_AGENT_TOKEN` | Yes | — | Scoped or global agent token |
| `NSTATUS_AGENT_ID` | No | `hostname` | VPS identifier (must match a target ID) |
| `NSTATUS_AGENT_LABEL` | No | `hostname` | Display label |
| `NSTATUS_INTERVAL_SEC` | No | `300` | Report upload interval |
| `NSTATUS_SAMPLE_SEC` | No | `1` | Local sample interval |
| `NSTATUS_PING_SEC` | No | `20` | TCP ping interval |
| `NSTATUS_PING_TARGETS` | No | `*` | Ping target filter (`*` = all, or `id1,id2`) |

---

## Agent

### Rust Agent (Recommended)

A standalone, single-binary Rust application. Statically linked with `musl` — works on any Linux distribution without dependencies.

**Features:**
- CPU usage (per-core and aggregate)
- Memory and swap usage
- Disk usage
- Load averages (1m, 5m, 15m)
- Network I/O rate (rx/tx bytes/sec)
- Disk I/O rate (read/write bytes/sec)
- TCP/UDP connection counts
- Process and thread counts
- System uptime
- VPS info (CPU model, cores, arch, OS, kernel, virtualization type)
- TCP ping latency to configurable targets
- Optional streaming service unlock detection (Netflix, Disney+, etc.)

**Build from source:**
```bash
cd agent
cargo build --release
# Or cross-compile for all platforms:
make build-linux     # 6 architectures: amd64, arm64, armv7, armv6, armv5, 386
make build-windows   # Windows amd64
```

**Pre-built binaries** are available on [GitHub Releases](https://github.com/3257085208/NIE-SLA/releases).

### Python Agent (OrangePi / Low-Resource)

For ARM SBCs (OrangePi, Raspberry Pi) that can't run the Rust binary:

```bash
cp agent/agent_orangepi.env.example agent_orangepi.env
# Edit agent_orangepi.env with your API URL, token and target ID
python3 agent/agent_orangepi.py
```

The Python agent runs HTTP/TCP checks locally and uploads batch results. It uses only Python 3 stdlib — no pip dependencies needed.

### Agent Management CLI

```bash
cftz status       # Check service status
cftz log 50       # View last 50 log lines
cftz set          # Reconfigure agent
cftz update       # Update to latest binary
cftz uninstall    # Full removal
```

---

## API Reference

Full API documentation is in [docs/api.md](docs/api.md). Key endpoints:

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/status` | Public | Status page data (all targets, summaries, incidents) |
| GET | `/api/checks?target_id=X` | Public | Per-target check history |
| GET | `/api/agent/metrics?agent_id=X` | Public | Agent telemetry time-series |
| POST | `/api/agent/metrics` | Agent | Submit Rust agent metrics |
| POST | `/api/agent/pings` | Agent | Submit TCP ping results |
| GET | `/api/agent/targets` | Agent | List targets for external probe agents |
| GET | `/api/agent/ping-targets` | Agent | List TCP ping targets |
| GET | `/api/agent/install-command?target_id=X` | Admin | Generate install command |
| GET | `/api/targets` | Admin | List all targets |
| POST | `/api/targets` | Admin | Create target |
| PATCH | `/api/targets/:id` | Admin | Update target |
| DELETE | `/api/targets/:id` | Admin | Delete target |
| POST | `/api/probe-now` | Admin | Trigger immediate probe |
| POST | `/api/alerts/check` | Admin | Force alert evaluation |
| GET | `/api/stats` | Admin | Database statistics |

---

## Security

### Agent Token Scoping

Each VPS gets a unique scoped token derived from the global `AGENT_TOKEN`:

```
scopedToken = "nst_" + sha256hex(AGENT_TOKEN + ":" + agent_id).slice(0, 48)
```

- A scoped token can only write metrics and pings for its own `agent_id`
- Old agents using the global `AGENT_TOKEN` are still compatible
- Admin panel install commands generate scoped tokens automatically
- Scoped tokens never need to be stored — they are deterministically derived

### Binary Integrity Verification

- Every agent binary has a SHA-256 checksum recorded in `bin/SHA256SUMS`
- Installers verify the binary checksum against the manifest before installation
- The manifest itself is pinned (hardcoded hash) to prevent tampering
- Override via `NSTATUS_SHA256SUMS_SHA256` for custom release pipelines

### Admin Authentication

- Bearer token (`ADMIN_TOKEN`)
- Cookie-based sessions (`__Host-nstatus-admin`, 24h TTL, HttpOnly Secure)
- Optional TOTP 2FA with AES-GCM encrypted secrets
- D1-backed durable rate limiting for login/TOTP endpoints

---

## Alerting

Configure Telegram alerts from the admin panel or via environment variables:

- **Offline alerts**: notified when a target goes down, and when it recovers
- **Resource alerts**: CPU, memory, disk, load, net rate, disk I/O, processes, threads
- **Expiry alerts**: warned N days before a VPS subscription expires
- **Traffic alerts**: notified when monthly traffic exceeds a percentage or GB threshold

Alerts are deduplicated with configurable cooldown (repeat_minutes). Per-target alert enable/disable with custom thresholds.

---

## Traffic Accounting

Per-VPS monthly traffic tracking with 4 billing modes:

| Mode | Description |
|---|---|
| `total` | Sum of rx + tx bytes |
| `tx` | Upload only |
| `rx` | Download only |
| `max` | Max of rx or tx |

- Traffic period aligns with the target's expiry date day-of-month
- Quota and billing mode configurable per target
- Traffic deltas are accumulated from the agent's raw network counters
- Visible in the public status page as progress bars

---

## Development

### Running Tests

```bash
./test.sh
```

Checks:
- Worker JS syntax (14 source files)
- Frontend JS syntax (3 source files + shared imports)
- Rust agent formatting, compilation, and Linux amd64 build
- Shell script syntax (all installers, update scripts, CLI)
- Repository hygiene (no real target data, safe install commands, etc.)

### Building the Agent

```bash
cd agent
cargo build --release                    # build for current platform
make build-linux                         # all 6 Linux targets
make build-windows                       # Windows amd64
make clean                               # remove build artifacts
```

### CI/CD

GitHub Actions workflow (`.github/workflows/agent-ci.yml`):
- `cargo fmt -- --check` for code style
- Cross-compilation for 7 platforms
- Automatic GitHub Release on tag push (`v*`)

---

## Cloudflare Free Tier Limits

The entire system is designed to stay within Cloudflare's free tier:

| Resource | Free Limit | Typical Usage |
|---|---|---|
| Worker requests | 100,000/day | ~17,280 (24h × 60min × 12 cron probes) |
| Worker CPU | 10ms per request | Well under with async batching |
| D1 rows read | 5,000,000/day | ~50,000 typical |
| D1 rows written | 100,000/day | ~10,000 typical |
| D1 storage | 5 GB | ~5-10 MB typical |
| R2 storage | 10 GB | ~100-500 MB typical (with retention) |
| R2 Class A ops | 1,000,000/month | ~100,000 typical |
| R2 Class B ops | 10,000,000/month | ~500,000 typical |

---

## License

[MIT License](LICENSE)

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for code conventions and the release process.

---

**Made with Rust + Cloudflare Workers**
