# Agent Setup

## Rust VPS Metrics Agent

The NIE-SLA Agent is a small Rust binary that collects system metrics and sends them outbound to the Worker. It does not listen on any port.

### One-Line Install

```bash
curl -fsSL https://your-pages-domain.example/install.sh | sudo sh
```

The interactive installer asks for API URL, Agent token, target name, and ping target selection. Admin-generated commands can pass those values non-interactively.

### Supported Binaries

| File | Platform |
|------|----------|
| `nstatus-metrics-linux-amd64` | Linux x86_64 VPS |
| `nstatus-metrics-linux-arm64` | Linux ARM64 / aarch64 |
| `nstatus-metrics-linux-arm` | Linux ARMv7 hard-float |
| `nstatus-metrics-linux-armv6` | Older ARM routers / embedded Linux |
| `nstatus-metrics-linux-386` | 32-bit x86 Linux |

OpenWrt/routers are supported when their CPU/ABI matches one of the Linux binaries. The installer needs `curl` or `wget`; the Agent runtime uses native Rust HTTPS and does not shell out to either tool.

### What It Collects

| Metric | Source | Sampling |
|--------|--------|----------|
| CPU | `sysinfo` / platform counters | Every 1s |
| Memory + Swap | `sysinfo` | Every 1s |
| Disk usage | `sysinfo` disks | Every 1s |
| Load | `sysinfo` load average | Every 1s |
| Network rate | `/proc/net/dev` on Linux | Every 1s |
| TCP/UDP connections | `/proc/net/tcp*`, `/proc/net/udp*` on Linux | Every 1s |
| Disk IO | `/proc/diskstats` on Linux | Every 1s |
| TCP Ping | Configured ping targets | Every 20s |
| VPS info | CPU, OS, kernel, memory, disk, virtualization | Cached at start |

The Agent samples locally every 1 second and uploads batches every 300 seconds by default. Uploads run in the background so slow network requests do not pause sampling.

### Management Commands

```bash
cftz install     # Fresh install
cftz update      # Update local binary + cftz script
cftz set         # Menu-based reconfiguration
cftz log [N]     # View last N log lines
cftz status      # Show service status
cftz uninstall   # Complete removal
```

### Build from Source

```bash
cd agent
cargo fmt -- --check
cargo check
./build-release.sh
```

`build-release.sh` uses Zig to build five statically linked Linux targets locally, then writes a matching `VERSION` and `SHA256SUMS`. GitHub Actions is not required to produce release artifacts.

## External Probe Agent (Python)

For running probes from a home network such as OrangePi:

```bash
scp agent_orangepi.py agent_orangepi.env.example user@orangepi:/opt/nstatus-agent/
cp agent_orangepi.env.example agent_orangepi.env
python3 /opt/nstatus-agent/agent_orangepi.py --once
sudo cp nstatus-agent.service /etc/systemd/system/
sudo systemctl enable --now nstatus-agent
```
