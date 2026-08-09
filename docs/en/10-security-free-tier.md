# Security and free-tier budget

## Credentials and auth

- Admin UI: password with short-lived sessions, optional GitHub OAuth (exact callback and username allowlist required) and TOTP.
- Each Agent uses an independent scoped token; install tickets are single-use and expire after redemption.
- Agents make outbound-only HTTPS calls; no remote admin port.
- Public responses strip secret fields and can mask IPs/ports.
- A leaked per-node token does not grant admin access.

## Fixed-action boundary

Beta actions need root, so they run outside the telemetry service. The Manager accepts only action identifiers the Worker returns and the local binary supports; admins cannot submit shell text, URLs, arguments, stdin, environments, or schedules. Script subprocesses get a cleaned environment plus download size, timeout, and output limits.

NodeQuality and IP.Check.Place download and run the scripts their services currently provide, including dependencies. That is an explicit external trust boundary of the two Beta features: trigger them manually only if you accept the provider; disabling them never affects monitoring.

Agent update manifest hashes come from the same Worker policy. They prevent transport corruption and mismatched artifacts but are not an independent offline signature; a compromised Worker or release environment remains an operational risk.

## Themes and extensions

- CSS themes run no script; Canvas themes run in an iframe without same-origin access and reach only the `status:read` bridge.
- Theme ZIPs are checked for size, file count, paths, types, manifest, and SHA-256; uploads stay disabled by default.
- Plugins, admin scripts, marketplace imports, and arbitrary extension runtimes are not available.
- Custom GeoIP URLs must be public HTTPS; explicit localhost, private, and cloud-metadata addresses are rejected.

## Backups

Normal backups contain no credentials. Sensitive backup passwords need at least 10 characters; keep file and password apart. A pre-restore R2 snapshot is automatic but does not replace an offline backup.

## Free-tier budget

Actual usage depends on VPS count, public traffic, ping volume, retries, history range, and alerts. Default design:

- Cron refreshes current state every minute; Agents still upload every 5 minutes.
- D1 uses 5-minute SLA buckets; the 30-day view reads incremental R2 daily stats.
- High-frequency metrics/pings enter per-agent Durable Objects and merge to R2 hourly.
- The traffic page merges unpersisted deltas; period rows persist at most every 30 minutes.
- Credential touch writes happen at most every 6 hours; snapshots every 5 minutes.
- Public endpoints cap history ranges and sample counts.

Estimate for 100 VPS with traffic accounting on, 2 external latency agents, 5-minute reporting, and minute-level current state (dynamic requests and writes only; static assets excluded):

| Resource | Estimate | Free cap | Headroom |
| --- | ---: | ---: | ---: |
| Workers requests | ~86,448/day | 100,000/day | ~13,552/day for pages and API |
| Durable Objects requests | at least ~28,800/day | 100,000/day | depends on reads and alerts; verify in Dashboard |
| D1 rows written | ~95,376/day | 100,000/day | ~4,624/day |
| D1 rows read | ~1-2.5M/day | 5,000,000/day | depends on traffic |
| R2 Class A | ~210,240/month | 1,000,000/month | ~789,760/month |

Official limits (check the docs for updates): Workers Free 100,000 requests/day with 10 ms CPU each; D1 Free 5,000,000 rows read and 100,000 rows written per day, 5 GB total storage; Durable Objects Free 100,000 requests/day, 5 GB SQLite storage; R2 Standard 10 GB-month free, Class A 1,000,000/month, Class B 10,000,000/month. Worker Static Assets requests are free and unlimited, but dynamic page/API requests that hit the Worker still count.

So the default configuration keeps 100 VPS at 5-minute reporting inside the free allowances in theory; D1 writes are the tightest budget. Heavy admin operations, retries, notification state changes, more than 2 latency agents, or changed intervals consume headroom. 200 VPS at 10-minute reporting exceeds the free caps. Set Dashboard alerts for Workers, Durable Objects, D1 rows written/read, and R2 Class A/B; if anything approaches 80% long-term, lower reporting frequency, reduce retries, or move to Workers Paid.

References:

- https://developers.cloudflare.com/workers/platform/limits/
- https://developers.cloudflare.com/workers/platform/pricing/
- https://developers.cloudflare.com/d1/platform/pricing/
- https://developers.cloudflare.com/durable-objects/platform/limits/
- https://developers.cloudflare.com/durable-objects/platform/pricing/
- https://developers.cloudflare.com/r2/pricing/
