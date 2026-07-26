# Architecture

New NIE-SLA deployments use one Worker application with Static Assets, D1, R2, Durable Objects, and one-minute Cron scheduling.

```text
Browser -> Worker + Static Assets
              |-- D1: configuration, current state, SLA, sessions
              |-- R2: metrics, pings, snapshots
              |-- Durable Objects: optional regional probes
VPS -> Rust Agent over outbound HTTPS
```

Cloudflare checks, Agent heartbeat, Agent TCP Ping, and external Latency Agents are independent signals.

The telemetry service runs unprivileged. A separate root runner accepts only the two fixed Beta action identifiers. Existing Target IDs and scoped credentials remain the compatibility boundary during migration.
