# API Reference

## Public Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | Health check |
| GET | `/api/status?days=30` | Status page data |
| GET | `/api/checks?target_id=xxx&limit=864&hours=72` | Check history |
| GET | `/api/agent/metrics?agent_id=xxx&hours=24` | VPS metrics |
| GET | `/api/agent/pings?agent_id=xxx&hours=24` | TCP ping data |
| GET | `/api/colo-echo` | Current CF colo |

## Admin Endpoints (admin session)

Call `POST /api/auth/login` with the configured username and password, then send the returned value as `x-admin-session`. Passwords are never accepted by CRUD endpoints.

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/targets` | List all targets |
| POST | `/api/targets` | Create target |
| PATCH | `/api/targets/:id` | Update target |
| DELETE | `/api/targets/:id` | Delete target |
| POST | `/api/probe-now` | Trigger immediate probe |
| POST | `/api/sync-targets` | Sync TARGETS_JSON |
| POST | `/api/archive` | Manual daily archive |
| POST | `/api/auth/login` | Username/password login; also verifies TOTP when enabled |
| GET | `/api/login` | Validate the current admin session |
| GET | `/api/settings` | Read public dashboard/admin settings |
| PATCH | `/api/settings` | Update public dashboard/admin settings |
| GET | `/api/stats` | Read system statistics |
| GET | `/api/agent/install-command?target_id=xxx` | Generate per-target install commands |
| POST | `/api/maintenance/cleanup` | Clean old volatile D1/R2 history |
| GET | `/api/ping-targets` | List TCP ping targets |
| POST | `/api/ping-targets` | Create TCP ping target |
| PATCH | `/api/ping-targets/:id` | Update TCP ping target |
| DELETE | `/api/ping-targets/:id` | Delete TCP ping target |
| POST | `/api/totp/setup` | Create a pending TOTP secret |
| POST | `/api/totp/verify` | Verify and enable/login with TOTP |
| POST | `/api/totp/disable` | Disable TOTP |

## Agent Endpoints (AGENT_TOKEN)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/agent/targets` | Get probe target list |
| POST | `/api/agent/results` | Submit probe results |
| POST | `/api/agent/metrics` | Submit VPS metrics |
| GET | `/api/agent/ping-targets` | List TCP ping targets |
| POST | `/api/agent/pings` | Submit ping results |

## Target Object

```json
{
  "name": "My Service",
  "group_name": "Web",
  "type": "http",
  "url": "https://example.com",
  "expected_status": "200,301,302",
  "timeout_ms": 5000,
  "interval_sec": 300,
  "probe_region": "auto"
}
```

## Probe Regions

`auto` | `apac` | `weur` | `eeur` | `enam` | `wnam` | `sam` | `oc` | `afr` | `me`
