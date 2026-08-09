# Agent

The Agent is a Rust collector on each VPS. It only makes outbound HTTPS requests to the Worker; it opens no listening port. Full reference (environment variables, commands, updates) is in `agent/README_zh.md`; this page covers deployment and troubleshooting.

## Deployment

Create a target in the admin panel, click "Deploy Agent", and run the generated per-node command on the VPS. The command embeds a scoped token, Agent ID, API/download base, expected version, and manifest hash. Treat it as a secret.

The installer detects the architecture, verifies the manifest and binary, validates the version, stops old processes, and installs a systemd or OpenRC service. Re-running the latest command updates safely and cleans up leftovers.

Resulting layout:

```text
/opt/nstatus-metrics/nstatus-metrics
/opt/nstatus-metrics/nstatus-metrics.env
/usr/local/bin/cftz
systemd or OpenRC service nstatus-metrics
```

## Data flow

- Samples CPU, memory, disk, load, IO, network, process/thread counts, uptime, and temperature every second.
- Uploads in batches every 300 seconds; offline samples stay in a bounded local queue.
- Runs TCP pings against admin-configured targets every 20 seconds.
- Reports raw cumulative NIC counters for monthly traffic accounting.

## Auto-update

Controlled dynamically by the admin toggle. When on, the Agent updates on its next policy check; when off, it never modifies itself. Manual `cftz update` ignores the toggle. Updates verify the `SHA256SUMS` pinned hash, the binary hash, and the version; on failure the old version stays.

## Beta actions

The Agent polls `/api/agent/tasks`. Only two compiled-in actions exist — NodeQuality and the IPv4 unlock check — executed by the root Manager while telemetry stays unprivileged. The task API returns action identifiers only, never script text, arguments, or stdin.

## Troubleshooting

Agent offline: check service state, token, API hostname, and HTTPS reachability.

```bash
sudo cftz status
sudo cftz log 100
sudo systemctl status nstatus-metrics --no-pager
```

Beta buttons stuck queued: outdated Agent, missing root channel, or unreachable API hostname. Re-run the latest install command for that node, then inspect the logs. NQ failures usually come from system permissions, missing dependencies, or upstream unavailability; IP unlock failures from upstream format changes or a VPS without usable IPv4.
