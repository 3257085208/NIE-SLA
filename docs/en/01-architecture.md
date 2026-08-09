# Architecture and data flow

NIE-SLA ships as a single Cloudflare Worker application that serves the static frontend, admin UI, API, and scheduled tasks. There is no central server.

```text
Worker + Static Assets
  |-- D1: configuration, current state, SLA buckets, sessions, alert state
  |-- R2: metric history, ping history, state snapshots, pre-restore snapshots
  |-- Durable Objects: regional probes (REGION_PROXY), per-agent hourly telemetry buffer (TELEMETRY_BUFFER)
  |-- Cron: every minute

Rust Agent
  |-- unprivileged telemetry service
  |-- root Manager (only the two fixed Beta actions)
  |-- outbound HTTPS only
```

## Four independent state sources

- Cloudflare HTTP/TCP checks: whether a public service is reachable.
- Agent online state: whether a VPS is still reporting.
- Agent TCP ping: latency from the VPS to configured TCP targets.
- External Latency Agents: latency to public TCP targets from other networks.

These states cannot replace each other. VPSes without public addresses use Agent online state instead of probe results, and a reporting Agent says nothing about whether Cloudflare can reach its ports.

## Write layering

Current state refreshes every minute; a full public snapshot is written to R2 every 5 minutes, and responses are overlaid with the latest D1 state, so page freshness does not depend on snapshot frequency. Long-term SLA uses 5-minute D1 buckets; the 30-day view reads incremental daily summaries in R2 and falls back to raw D1 buckets only when stale.

High-frequency metrics and pings go into a Durable Object isolated per Agent ID. The current hour is read directly from the buffer; when the hour ends, the data merges into one R2 object after a retry overlap window. Agents keep uploading every 5 minutes, but R2 Class A operations drop from once per upload to once per agent per hour.

Traffic uses a current-period row plus a daily ledger. The page merges the difference between the latest NIC counters and the persisted row in real time; the period row persists at most every 30 minutes and immediately on day rollover, counter reset, or period change. Changing the reset day recomputes from the retained daily data.

## Compatibility tables

`targets` remains the stable identifier source for old Agents and existing admin code; `nodes/checks` is the structured compatibility table. Migrations and restores rebuild rows by the original Target ID.

## Legacy Pages + Worker migration

Existing Pages + Worker installs can move to Worker Static Assets without downtime. Reuse the D1, R2, Agent API hostname, and encryption material; the Agent protocol is unchanged and installed Agents keep working.
