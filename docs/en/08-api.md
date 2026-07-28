# API Reference

Public read-only endpoints include `/api/health`, `/api/status`, `/api/checks`, `/api/agent/metrics`, `/api/agent/pings`, `/api/latency`, `/api/themes`, and enabled versioned theme files under `/api/themes/file/:id/@:revision/*`.

`GET /api/v1` provides a versioned read-only manifest for alternate frontends. Sandboxed Canvas themes may request only its status, checks, metrics, pings, and latency resources through the parent message bridge. Plugins and arbitrary extension uploads are not available.

Authenticated Agent endpoints provide metrics, Ping targets, GeoIP configuration/location reporting, fixed task claim/result, and update policy. Task responses contain only `nodequality` or `ip_unlock`.

Admin APIs require a valid `x-admin-session` and cover targets, scoped credentials, GeoIP settings, fixed tasks, alerts, appearance, updates, backup/restore, and theme package management. Theme uploads use `POST /api/themes/upload` with `application/zip` and the browser-computed digest in `x-theme-sha256`.
