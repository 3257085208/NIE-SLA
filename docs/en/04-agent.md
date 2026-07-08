# 04 Agent

## Installation

Use the admin-generated command whenever possible. It detects root vs sudo and passes the correct Agent ID and label.

The generated command now explicitly includes `NSTATUS_PING_TARGETS="*"` and `NSTATUS_PING_SEC="20"`, and the installer writes both values to the Agent environment file. `*` means the Agent fetches every enabled target from Ping management. To limit one VPS to selected probes, replace it with comma-separated Ping target IDs.

For networks where `workers.dev` or `pages.dev` is unreachable, do not point `NSTATUS_API_BASE` at those public suffixes. Use your custom Pages/Worker domain instead, for example `https://sla.example.com`. When the admin panel is opened from the custom frontend domain, generated install commands prefer that custom domain as the Agent API base.

## Service Management

```bash
systemctl status nstatus-metrics
journalctl -u nstatus-metrics -f
systemctl restart nstatus-metrics
```

## cftz Helper

```bash
cftz status
cftz log 100
cftz set
cftz update
cftz uninstall
```

## Collected Metrics

The Agent reports CPU, memory, swap, disk usage, load averages, network rate, cumulative network counters, TCP/UDP connections, disk IO, process count, thread count, hostname, OS, kernel, architecture, virtualization, CPU model, core count, uptime, Agent version, and ping results.

## Traffic Accounting After Reboot

The Worker stores monthly accumulated traffic plus the last raw interface counters seen from the Agent. If a VPS reboots and raw counters reset, the next report becomes a new baseline. This prevents double counting or huge false deltas. It is conservative monthly accounting, not carrier-grade billing precision.
