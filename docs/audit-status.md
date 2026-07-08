# Audit Status

This file replaces the older generated bug/status reports that contradicted each other.

## Current Fixed Items

- Agent runtime HTTP uses a native Rust HTTPS client (`ureq` + `rustls`) instead of spawning `curl` or `wget`.
- Agent runtime requests do not expose the Agent token through process arguments.
- TOTP secrets are encrypted with `TOTP_ENCRYPTION_KEY`; legacy plaintext or ADMIN_TOKEN-derived rows are migrated after successful verification.
- Security-sensitive rate limits use D1 by default.
- D1 rate limit failures now fail closed for authenticated/write routes instead of silently allowing the request.
- Windows install no longer defaults to SYSTEM or `ExecutionPolicy Bypass`.
- Chart.js is served locally instead of from a CDN.
- `sanitizeId` is deterministic for empty or fully sanitized input.
- Public SQL schema files no longer contain real target IPs or domains.
- Admin HTML/CSS are kept in readable source form.
- Scheduled maintenance no longer depends on the 5-minute modulo hack; it uses an hourly claim in D1 and honors a dedicated hourly cron if one is added later.
- Root generated reports and unsafe one-click deployment notes were removed; deployment docs no longer recommend publishing Agent tokens.
- Agent install script defaults now point at the current Pages host instead of the stale temporary Pages URL.
- `cftz` admin API calls pass auth headers through temporary curl config files so tokens and TOTP codes are not exposed as process arguments.
- API docs now include settings, stats, maintenance, ping target, install command, and TOTP endpoints.
- Worker utility tests cover boolean parsing, deterministic IDs, traffic reset dates, and fail-closed D1 rate limiting.
- Telegram alerting is handled by Worker cron with D1-backed alert state; it covers offline/online, resource thresholds, expiry, and traffic quota without adding WebSocket/DO connection state.
- Documentation has been rebuilt into bilingual README files plus focused Chinese and English guide files under `docs/zh-CN/` and `docs/en/`.

## Known Remaining Work

- `frontend/app.js` is still large and should be split into modules.
- Some deployment and maintenance examples still use `curl` for operator-driven actions; keep secrets in stdin, temporary config files, or interactive prompts instead of command arguments.
- More integration tests are needed for Worker routes, traffic accounting, TOTP setup/verify, and Agent telemetry ingest.
- Frontend rendering still uses string templates, but polling now avoids overlapping status requests and skips group DOM rebuilds when the status payload is unchanged.

## Policy

Do not add new generated audit reports at the repository root. Keep the current status here or in focused issue tracker entries.
