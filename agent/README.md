# NStatus Agent

This directory contains the Rust Agent, Linux/Windows installers, service templates, helper scripts, and release binaries used by NIE-SLA / NStatus.

- 中文完整文档：[../README.zh-CN.md](../README.zh-CN.md)
- English documentation: [../README.en.md](../README.en.md)
- Agent guide CN: [../docs/zh-CN/04-agent.md](../docs/zh-CN/04-agent.md)
- Agent guide EN: [../docs/en/04-agent.md](../docs/en/04-agent.md)

## What the Agent Does

- Collects CPU, memory, swap, disk, load, network, disk IO, process count, thread count, OS/kernel/architecture/virtualization, uptime, and Agent version.
- Runs TCP ping checks against targets managed in the admin panel.
- Uploads metrics to the Worker through outbound HTTPS only.
- Provides raw cumulative network counters so the Worker can perform per-VPS monthly traffic accounting.

## Runtime Security

The Agent runtime uses native Rust HTTPS (`ureq` + `rustls`) for API calls.

## Build

```bash
cd agent
cargo fmt -- --check
cargo check
cargo build --release --target x86_64-unknown-linux-musl
```
