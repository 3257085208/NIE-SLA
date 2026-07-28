# Architecture

New NIE-SLA deployments use one Worker application with Static Assets, D1, R2, Durable Objects, and one-minute Cron scheduling.

```text
Browser -> Worker + Static Assets
              |-- D1: configuration, current state, SLA, sessions
              |-- R2: metrics, pings, snapshots
              |-- Durable Objects: regional probes and per-Agent hourly telemetry buffers
VPS -> Rust Agent over outbound HTTPS
```

Cloudflare checks, Agent heartbeat, Agent TCP Ping, and external Latency Agents are independent signals.

The five-minute Agent upload interval is unchanged. Metrics and Ping samples are first stored in an Agent-isolated Durable Object, remain readable for the active hour, and are merged into one R2 object per completed Agent hour. Five-minute D1 SLA buckets remain the durable availability source, while public 30-day summaries normally use incrementally maintained R2 daily totals and query raw D1 buckets only as a recovery path.

The telemetry service runs unprivileged. A separate root runner accepts only the two fixed Beta action identifiers. Existing Target IDs and scoped credentials remain the compatibility boundary during migration.
