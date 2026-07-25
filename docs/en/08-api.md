# 08 API Reference

## Authentication

Password and GitHub OAuth login endpoints issue a short-lived admin session. Admin endpoints use `x-admin-session`; passwords are never replayed as API bearer tokens. Agent endpoints continue to use scoped bearer tokens.

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
| GET | `/api/nq/:target_id` | Parsed NodeQuality report for an enabled TCP/VPS target |

`/api/nq/:target_id` is also available as `/api/nodequality/:target_id`. The response contains the extracted report time, original report link, ANSI tabs, and image tabs; the stored raw report is never returned. Missing reports, HTTP targets, and disabled targets return `404`.

## Admin Endpoints

| Method | Path | Description |
| --- | --- | --- |
| GET | `/api/auth/config` | Available login providers |
| POST | `/api/auth/login` | Username/password and optional TOTP login |
| GET | `/api/auth/github/start` | Start optional GitHub OAuth |
| GET | `/api/auth/github/callback` | GitHub OAuth callback |
| POST | `/api/auth/github/complete` | Exchange a one-time OAuth ticket for a session |
| GET/POST | `/api/targets` | List/create targets |
| PATCH/DELETE | `/api/targets/:id` | Update/delete target |
| POST | `/api/probe-now` | Run probes now |
| GET/PATCH | `/api/settings` | Public settings |
| GET/PATCH | `/api/alerts/settings` | Alert settings |
| POST | `/api/alerts/test` | Send a Telegram or email test |
| POST | `/api/alerts/check` | Evaluate alerts now |
| GET | `/api/system/update` | Read installed/latest versions and the in-app changelog |
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
