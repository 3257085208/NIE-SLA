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

## Agent Endpoints

| Method | Path | Description |
| --- | --- | --- |
| GET | `/api/agent/targets` | Probe targets |
| POST | `/api/agent/results` | Probe results |
| POST | `/api/agent/metrics` | System metrics |
| GET | `/api/agent/ping-targets` | Ping targets |
| POST | `/api/agent/pings` | Ping results |
