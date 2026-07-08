# NStatus Agent — VPS Metrics Collector

A lightweight Rust binary that collects VPS system telemetry and uploads it to an NStatus Worker.

## Features

- **System Metrics**: CPU, memory, disk, load, network I/O, disk I/O
- **Process Info**: Process count, thread count, system uptime
- **VPS Info**: CPU model, cores, architecture, OS, kernel, virtualization type
- **TCP Ping**: Latency to configurable targets
- **Unlock Detection**: Optional streaming service unlock status (Netflix, Disney+, etc.)
- **Multi-Arch**: Pre-built binaries for 7 platforms (see below)

## Supported Platforms

| Binary | Platform |
|---|---|
| `nstatus-metrics-linux-amd64` | Linux x86_64 |
| `nstatus-metrics-linux-arm64` | Linux ARM64 (aarch64) |
| `nstatus-metrics-linux-arm` | Linux ARMv7 hard-float |
| `nstatus-metrics-linux-armv6` | Older ARM / embedded Linux |
| `nstatus-metrics-linux-armv5` | Soft-float ARM devices |
| `nstatus-metrics-linux-386` | 32-bit x86 Linux |
| `nstatus-metrics-windows-amd64.exe` | Windows x86_64 |

All Linux binaries are statically linked with `musl` — no glibc dependency, works on any Linux distribution.

## Quick Install

### Linux (from GitHub Releases)

```bash
# One-line install (get your token from the admin panel)
curl -fsSL https://github.com/3257085208/NIE-SLA/releases/latest/download/install.sh | sudo sh

# Interactive setup will ask for:
#   - API URL: https://your-worker.your-subdomain.workers.dev
#   - Agent Token: nst_xxxx (from admin panel)
#   - Target ID: your VPS hostname
```

### Windows (PowerShell as Administrator)

```powershell
$env:DOWNLOAD_BASE = "https://github.com/3257085208/NIE-SLA/releases/latest/download"
$env:NSTATUS_API_BASE = "https://your-worker.your-subdomain.workers.dev"
$env:NSTATUS_AGENT_TOKEN = "nst_xxxx"
iex (iwr -UseBasicParsing "$env:DOWNLOAD_BASE/install.ps1").Content
```

## Build from Source

### Prerequisites

- [Rust](https://rustup.rs/) ≥ 1.80
- For cross-compilation: `rustup target add <target>`

### Build

```bash
# Current platform
cargo build --release

# Specific platform
cargo build --release --target x86_64-unknown-linux-musl

# All Linux platforms
make build-linux

# Windows
make build-windows
```

### Cross-Compilation Targets

```bash
rustup target add x86_64-unknown-linux-musl
rustup target add aarch64-unknown-linux-musl
rustup target add armv7-unknown-linux-musleabihf
rustup target add arm-unknown-linux-musleabihf
rustup target add armv5te-unknown-linux-musleabi
rustup target add i686-unknown-linux-musl
rustup target add x86_64-pc-windows-msvc
```

## Configuration

All configuration via environment variables:

| Variable | Default | Description |
|---|---|---|
| `NSTATUS_API_BASE` | (required) | Worker API URL |
| `NSTATUS_AGENT_TOKEN` | (required) | Scoped or global agent token |
| `NSTATUS_AGENT_ID` | hostname | VPS identifier |
| `NSTATUS_AGENT_LABEL` | hostname | Display label |
| `NSTATUS_INTERVAL_SEC` | 300 | Upload interval (seconds) |
| `NSTATUS_SAMPLE_SEC` | 1 | Sample interval (seconds) |
| `NSTATUS_PING_SEC` | 20 | TCP ping interval (seconds) |
| `NSTATUS_PING_TARGETS` | `*` | Ping target filter |
| `NSTATUS_UNLOCK_CHECK_ENABLED` | 1 (Linux) | Enable unlock check |
| `NSTATUS_UNLOCK_CHECK_SEC` | 300 | Unlock check interval |
| `NSTATUS_UNLOCK_CHECK_URL` | `https://IP.Check.Place` | Unlock script URL |
| `NSTATUS_UNLOCK_CHECK_TIMEOUT_SEC` | 90 | Unlock check timeout |

## CLI Arguments

```
--api URL            Worker API base URL
--token TOKEN        Agent token
--agent-id ID        Target ID (default: hostname)
--agent-label LABEL  Display label
--once               Run one cycle and exit
--version            Print version
```

## Management CLI (`cftz`)

After installation, use the `cftz` command to manage the agent:

```bash
cftz status        # Check if the service is running
cftz log 50        # View recent logs
cftz set           # Reconfigure API URL, token, interval, etc.
cftz update        # Download and install the latest binary
cftz uninstall     # Stop and remove the agent completely
```

## Init Systems

### systemd (Linux)

The agent runs as a systemd service (`nstatus-metrics`) under a dedicated `nstatus` user. Management:

```bash
systemctl status nstatus-metrics
journalctl -u nstatus-metrics -f
systemctl restart nstatus-metrics
```

### OpenRC (Alpine Linux)

```bash
rc-service nstatus-metrics status
tail -f /var/log/nstatus-metrics.log
rc-service nstatus-metrics restart
```

### Windows (Scheduled Task)

The agent runs as a Scheduled Task (`NStatusMetrics`) triggered at user logon.

## Data Flow

```
Every 1s:  Sample CPU, memory, disk, load, net rate, disk I/O
Every 20s: TCP ping configured targets
Every 300s: Check unlock status (if enabled)
Every 300s: Upload batched metrics + pings to Worker
            On failure: retry every 10-60s
```

## Python Alternative Agent

For extremely resource-constrained devices (OrangePi Zero 3, etc.):

```bash
cp agent/agent_orangepi.env.example agent_orangepi.env
# Edit the env file with your API URL, token, and target ID
python3 agent/agent_orangepi.py
```

The Python agent runs HTTP/TCP checks locally using only Python 3 stdlib.

## Security

- Agent makes outbound HTTPS only — no ports to open
- Runs as unprivileged `nstatus` user (systemd/OpenRC)
- `NoNewPrivileges=true`, `ProtectSystem=strict`, `ProtectHome=true` (systemd)
- Binary SHA-256 verification on install and update
- Manifest hash pinned to prevent tampering
