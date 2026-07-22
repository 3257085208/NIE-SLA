# 12 External Latency Agents

An external Latency Agent is a lightweight Python service that measures every eligible public TCP target from an additional Linux network. It is separate from the Rust VPS telemetry Agent and from Cloudflare's built-in probes.

## Data Sources

| Source | Runs on | Purpose |
| --- | --- | --- |
| Cloudflare Latency | Worker / Durable Object | Cloudflare-to-target TCP latency |
| VPS telemetry Agent | Monitored VPS | CPU, memory, disk, traffic, uptime, and health |
| Agent TCP Ping | Monitored VPS | VPS-to-managed-ping-target latency |
| External Latency Agent | Independent Linux node | Additional-network-to-public-TCP-target latency |

Creating a Latency node in the admin panel only creates its database identity. The node is not active until its service successfully submits results. The admin panel then receives a last-report timestamp, and the public Latency chart adds that source.

## Requirements

- Linux with systemd.
- Python 3 and `curl`.
- HTTPS access to the Pages install host and Worker API.
- At least one enabled public TCP target with a host and port.

The service does not install the Rust metrics Agent, report its own system metrics, or listen on a public port.

## Installation

1. Open Admin -> Latency.
2. Create a node with a stable location/network name.
3. Click Deploy for that node.
4. Run the complete generated command as root on the matching Linux node.
5. Do not reuse another node's command; each command contains a node-scoped token.

A successful installation includes an initial one-shot probe:

```text
Validating Latency API access and submitting an initial probe...
{"ok":true,"targets":38,"accepted":38}
External Latency Agent installed: latency-example
```

`targets` is the number of eligible targets returned by the Worker. `accepted` is the number of results validated and stored. A positive matching count confirms target retrieval, authentication, probing, and D1 writes.

## Verification

```bash
sudo systemctl is-active nstatus-latency-agent.service
sudo systemctl status nstatus-latency-agent.service --no-pager
sudo journalctl -u nstatus-latency-agent.service -n 100 --no-pager
```

Run one cycle manually:

```bash
sudo sh -c 'set -a; . /etc/nstatus-latency-agent.env; set +a; /usr/bin/python3 /opt/nstatus-latency/latency-agent.py --once'
```

After a successful report, Admin -> Latency should show a recent report time. The public page normally adds the source after the short Worker status cache refreshes.

From the Worker directory, operators can verify D1:

```bash
npx wrangler d1 execute nstatus-db --remote --command \
  "SELECT id,name,last_seen_at FROM latency_agents ORDER BY name;"

npx wrangler d1 execute nstatus-db --remote --command \
  "SELECT node_id,COUNT(*) AS count,MAX(checked_at) AS newest FROM latency_results GROUP BY node_id;"
```

## Upgrading Old Installations

If an older node remains at "Never reported", generate a fresh command from the current admin panel and run the full installer again. Restarting the old service is not sufficient.

Older Python `urllib` defaults may be rejected by Cloudflare Browser Integrity Check with error 1010 before the request reaches the Worker. The current script sends an explicit `NStatus-Latency/1.0` User-Agent and runs `--once` during installation so API, token, or edge-policy failures are visible immediately.

## Troubleshooting

### The node exists but never reports

- Verify the latest command was run on the matching machine.
- Require a successful `accepted` count, not only a systemd installation message.
- Check service status and journal logs.
- Check DNS, TLS, system time, and outbound HTTPS connectivity.

### HTTP 401

The token and node ID do not match, a command from another node was reused, or the Worker `AGENT_TOKEN` changed. Generate a new command for this node and reinstall it instead of assembling a token manually.

### Cloudflare 1010 or 403

Reinstall with the current admin-generated command. Confirm the installed Python file sends an explicit `User-Agent` header.

### `targets` or `accepted` is zero

External nodes only receive enabled TCP targets with a public host and port. HTTP targets and targets configured to hide their public address are excluded.

### Admin reports activity but the public chart only shows Cloudflare

- Wait for the short status cache to refresh and reload the page.
- Verify the selected target is an eligible public TCP target.
- Confirm the service continues to report; stale sources are hidden.
- Query `latency_results` for recent rows for that target.

Do not publish `/etc/nstatus-latency-agent.env` or a generated install command. Both contain a scoped credential.
