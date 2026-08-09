# API

## Public endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/health` | health check |
| GET | `/api/status` | targets, state, summary, public agent metrics, unlock results |
| GET | `/api/checks?target_id=...` | Cloudflare check history for one target |
| GET | `/api/agent/metrics?agent_id=...` | public agent metrics |
| GET | `/api/agent/pings?agent_id=...` | agent TCP pings |
| GET | `/api/latency?target_id=...` | external latency history |
| GET | `/api/v1` | versioned read-only developer API manifest |
| GET | `/api/themes` | public list of the enabled theme |
| GET | `/api/themes/file/:id/@:revision/*` | versioned resources inside the enabled theme |

`/api/v1` and `/api/v1/*` form the stable read-only line for third-party frontends. Theme canvases reach allow-listed resources only through the parent page proxy. Plugin and arbitrary extension uploads are not available.

The legacy paste-in NodeQuality report endpoint stays read-only for compatibility. Beta NQ tasks store structured results collected by the Agent; the Worker only uploads locally rendered SVGs, and public report image URLs always point at the same-origin proxy.

## Agent endpoints

Authenticated with per-node Bearer tokens:

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/api/agent/metrics` | upload metrics |
| GET | `/api/agent/ping-targets` | fetch ping configuration |
| POST | `/api/agent/pings` | upload pings |
| GET | `/api/agent/config` | fetch GeoIP configuration |
| POST | `/api/agent/location` | report IPv4/IPv6 location |
| GET | `/api/agent/tasks` | claim fixed Beta actions |
| POST | `/api/agent/tasks/:id` | report task results |
| GET | `/api/agent/update-policy` | fetch update policy |

The task API returns only the `nodequality` or `ip_unlock` action identifier, never script text, arguments, or stdin.

## Admin endpoints

Require a valid `x-admin-session`: targets, pings, latency agents, ordering; install commands and credential rotation; GeoIP settings; fixed-task create/list/cancel; Telegram, email, and rules; appearance, admin path, updates; backup export, preview, restore; theme list, upload, enable, disable, delete.

Passwords are sent only to the login endpoint; they are never used as general API tokens.

## Limits

Public history endpoints cap time ranges and sample counts, strip sensitive fields, and mask addresses/ports per privacy settings. Third-party frontends must handle `429`, cache headers, and missing fields instead of relying on internal table layouts.
