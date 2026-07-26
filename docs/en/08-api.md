# API Reference

Public read-only endpoints include `/api/health`, `/api/status`, `/api/checks`, `/api/agent/metrics`, `/api/agent/pings`, and `/api/latency`.

`GET /api/v1` provides a versioned read-only manifest for alternate frontends. Write plugins, theme packages, and upload runtimes are not available.

Authenticated Agent endpoints provide metrics, Ping targets, GeoIP configuration/location reporting, fixed task claim/result, and update policy. Task responses contain only `nodequality` or `ip_unlock`.

Admin APIs require a valid `x-admin-session` and cover targets, scoped credentials, GeoIP settings, fixed tasks, alerts, appearance, updates, and backup/restore.
