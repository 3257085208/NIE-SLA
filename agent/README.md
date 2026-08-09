# NIE-SLA Agent

The Rust agent for NIE-SLA. It collects VPS system metrics, runs TCP ping checks, and reports everything to the Worker over outbound HTTPS only. It never opens an inbound listening port.

Complete documentation: [中文完整文档](../README.zh-CN.md) / [Agent 指南](../docs/zh-CN/04-agent.md) / [Agent guide EN](../docs/en/04-agent.md).

## What it does

- Samples CPU, memory, swap, disk, load, network counters, disk IO, process and thread counts, OS/kernel/architecture/virtualization, uptime, and temperature once per second by default.
- Runs TCP pings against targets configured in the admin panel.
- Uploads metrics roughly every 300 seconds in batches; samples accumulate in a bounded local queue while offline.
- Reports raw cumulative network counters so the Worker can do per-VPS monthly traffic accounting.
- Polls the update policy and can update itself through a checksum-verified chain.

## Layout after install

```text
/opt/nstatus-metrics/nstatus-metrics
/opt/nstatus-metrics/nstatus-metrics.env
/usr/local/bin/cftz
systemd or OpenRC service nstatus-metrics
```

## Runtime security

The agent talks to the Worker with native Rust HTTPS (`ureq` + `rustls`). Each node uses its own scoped token. The telemetry service runs as the unprivileged `nstatus` user; the two fixed Beta actions (NodeQuality, IPv4 unlock check) run under the root-only Manager, which accepts only compiled-in action identifiers.

## Build

```bash
cd agent
cargo fmt -- --check
cargo check --locked
cargo build --release --target x86_64-unknown-linux-musl
```

## Full local release

```bash
./build-release.sh
```

Builds Linux amd64, arm64, armv7, armv6, and 386 via Zig, then writes a matching `VERSION` and `SHA256SUMS` into `bin/`. Existing artifacts are not replaced unless every target builds. Pass an output directory as the first argument, or set `RUST_TOOLCHAIN` to pin the toolchain. GitHub Actions is not required.

## Legacy Python agent

`agent_orangepi.py` and its systemd template are deprecated and kept only for old home-network installs. New installs must use the Rust agent. See `DEPRECATED_PYTHON.md`.
