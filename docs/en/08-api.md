# 08 API Reference

## Authentication

Admin endpoints use `Authorization: Bearer ADMIN_TOKEN` and optionally `x-admin-session` after TOTP. Agent endpoints use `Authorization: Bearer AGENT_TOKEN`.

## Public Endpoints

| Method | Path | Description |
| --- | --- | --- |
| GET | `/` | Health |
| GET | `/api/status?days=30` | Status payload |
| GET | `/api/checks?target_id=ID&hours=72` | Target history |
| GET | `/api/agent/metrics?agent_id=ID` | Agent metrics |
| GET | `/api/agent/pings?agent_id=ID` | Agent pings |
| GET | `/api/latency?target_id=ID&hours=24` | External Latency Agent history |
| GET | `/api/colo-echo` | Cloudflare colo echo |

## Admin Endpoints

| Method | Path | Description |
| --- | --- | --- |
| GET/POST | `/api/targets` | List/create targets |
| PATCH/DELETE | `/api/targets/:id` | Update/delete target |
| POST | `/api/probe-now` | Run probes now |
| GET/PATCH | `/api/settings` | Public settings |
| GET/PATCH | `/api/alerts/settings` | Alert settings |
| POST | `/api/alerts/test` | Send test Telegram message |
| POST | `/api/alerts/check` | Evaluate alerts now |
| GET/POST | `/api/ping-targets` | Ping target management |
| POST | `/api/totp/setup` | Setup TOTP |
| POST | `/api/totp/verify` | Verify TOTP |
| POST | `/api/totp/disable` | Disable TOTP |
| GET/POST | `/api/latency-agents` | List/create external Latency nodes |
| PATCH/DELETE | `/api/latency-agents/:id` | Update/delete an external Latency node |
| GET | `/api/latency-agent/install-command?node_id=ID` | Generate a node-scoped install command |

## Agent Endpoints

| Method | Path | Description |
| --- | --- | --- |
| GET | `/api/agent/targets` | Probe targets |
| POST | `/api/agent/results` | Probe results |
| POST | `/api/agent/metrics` | System metrics |
| GET | `/api/agent/ping-targets` | Ping targets |
| POST | `/api/agent/pings` | Ping results |
| GET | `/api/latency-agent/targets?node_id=ID` | External Latency Agent target list |
| POST | `/api/latency-agent/results` | External Latency Agent results |
| GET | `/api/latency-agent/update-policy?node_id=ID` | External Latency Agent update policy |
| GET | `/api/v1` | Versioned public API capability manifest |
| GET | `/api/extensions` | Enabled public extension registry |
| GET | `/api/themes/manage` | Installed themes (Admin) |
| POST | `/api/themes/upload` | Upload a theme ZIP; accepts `type: theme` only (Admin) |
| PATCH/DELETE | `/api/themes/:id` | Enable, disable, or delete a theme (Admin) |
| GET | `/api/plugins/manage` | Installed plugins (Admin) |
| POST | `/api/plugins/upload` | Upload a plugin ZIP; accepts `type: plugin` only (Admin) |
| PATCH/DELETE | `/api/plugins/:id` | Enable, disable, or delete a plugin (Admin) |
