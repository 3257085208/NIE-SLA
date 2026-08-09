# External Latency Agents

An External Latency Agent is a lightweight TCP probe separate from the VPS monitoring Agent. Run it on home broadband, cloud servers, or other provider networks to measure the same set of public TCP targets from multiple vantage points.

## Data paths

| Data | Initiator | Purpose |
| --- | --- | --- |
| CF latency | Worker / Durable Object | Cloudflare-to-target TCP latency |
| VPS agent metrics | Rust agent on the monitored VPS | CPU, memory, disk, traffic, online state |
| Agent TCP ping | Rust agent on the monitored VPS | latency from that VPS to configured targets |
| External latency | Python service on an independent node | latency from extra networks to all public TCP targets |

Creating a latency node in the admin panel only records the node ID. The source appears in the public latency legend only after the node submits results.

## Requirements

- Linux with systemd.
- Python 3 and `curl` available.
- HTTPS access to the Worker site and API.
- Probes only targets that are enabled, type TCP, have complete public host/port, and do not hide the public address.

The External Latency Agent does not install the Rust metrics agent, does not report its own CPU/memory/traffic, and opens no public port.

## Create and deploy

1. In the admin panel, open "Latency".
2. Add a node with a stable, location-descriptive name.
3. Click "Deploy" on the node.
4. Copy the generated Linux command.
5. Run it as root on the target node. Never reuse another node's command.

The command contains a node-scoped token; treat it as sensitive. The installer checks systemd and Python 3, stops and disables any existing `nstatus-latency-agent.service` plus leftover processes, downloads the versioned `latency-agent.py`, writes a `0600` env file, runs a `--once` preflight that submits the first results, starts the service, and verifies it is active. Reinstall or token rotation is just re-running the latest command.

Successful output looks like:

```text
Validating Latency API access and submitting an initial probe...
{"ok":true,"targets":38,"accepted":38}
External Latency Agent installed: latency-example
```

`targets` is the number of probe-able TCP targets returned by the Worker; `accepted` is how many results were accepted. Equal and greater than zero means fetch, probe, token validation, and write all worked.

## Verification

```bash
sudo systemctl is-active nstatus-latency-agent.service
sudo systemctl status nstatus-latency-agent.service --no-pager
sudo journalctl -u nstatus-latency-agent.service -n 100 --no-pager
```

Manual run:

```bash
sudo sh -c 'set -a; . /etc/nstatus-latency-agent.env; set +a; /usr/bin/python3 /opt/nstatus-latency/latency-agent.py --once'
```

Back in the admin panel, the node should be enabled with a recent "last report" time. Open a qualifying VPS on the public page; the latency legend should show Cloudflare plus the external node name. The public status API only shows unexpired sources; new results usually appear within tens of seconds, and silent sources are hidden after the Worker's stale window.

Query D1 from the Worker directory:

```bash
npx wrangler d1 execute nstatus-db --remote --command \
  "SELECT id,name,last_seen_at FROM latency_agents ORDER BY name;"

npx wrangler d1 execute nstatus-db --remote --command \
  "SELECT node_id,COUNT(*) AS count,MAX(checked_at) AS newest FROM latency_results GROUP BY node_id;"
```

## Auto-update

The admin "Agent auto-update" toggle controls both the Rust agent and external latency agents. The latency agent polls `/api/latency-agent/update-policy` with its own node token:

- Off: it only reads the policy and never modifies the script.
- On: it downloads the current script from the HTTPS install base recorded in the install command, enforces a size limit, compares SHA-256, runs a Python compile check, then atomically replaces the script under `/opt/nstatus-latency` and restarts via `exec`.
- Failed checks only write to the journal; probing continues and retries after an hour.

Enabling this for the first time requires re-running the latest install command to record the install base and update the systemd sandbox permissions.

## Upgrading old nodes

Nodes installed by older scripts may show "not yet reported" forever. Do not just restart the service: click "Deploy" again, copy the new command, and reinstall fully. Only a visible `{"ok":true,...,"accepted":...}` counts as upgraded.

Old Python `urllib` default User-Agent can be blocked by Cloudflare Browser Integrity Check with error 1010 before reaching the Worker. The current script sends `NIE-SLA-Latency/1.0` explicitly and surfaces API, token, or edge policy problems immediately via `--once`.

## Common failures

- Node exists but "not yet reported": confirm the correct machine ran the node's latest full command, the install output showed `accepted`, the service is active, logs show no persistent 401/403/TLS/DNS errors, and system time is correct.
- 401: token/node ID mismatch or a reused command from another node. Regenerate the command for the current node and reinstall; do not hand-assemble tokens.
- Cloudflare 1010/403: confirm the script sends an explicit `User-Agent`; the fastest fix is re-running the latest install command.
- `targets` or `accepted` is 0: the admin panel needs at least one enabled TCP target with complete host/port that does not hide its public address. HTTP targets are not distributed.
- First success but the frontend still shows only Cloudflare: wait for the state cache refresh (tens of seconds), hard-refresh, confirm you are viewing a public TCP target, and check `latency_results` for fresh data.
- Service restarts in a loop: inspect systemd and journal logs. Never paste the full contents of `/etc/nstatus-latency-agent.env` anywhere public; it contains the node token.

## Delete and disable

Disabling keeps history but stops the source from being shown. Deleting removes the node and its result history irreversibly. Renaming needs no reinstall; changing the node ID requires deploying with a new command.
