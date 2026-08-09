# Admin panel

The admin UI uses a username/password login with short-lived sessions, optional GitHub OAuth, and optional TOTP. The admin path is configurable; the old path returns 404 after a change. The path is not authentication.

## Probes

TCP/VPS targets support name, group, ordering, provider, machine type, price, currency, billing cycle, expiry, an independent traffic reset day, quota, accounting mode, tags, alert thresholds, and a public address toggle. Name is the only required field.

Country and city are read-only and reported by the Agent from its exit IPv4/IPv6. The provider is chosen under "Settings → Auto GeoIP": IP.SB, Cloudflare, IPIP.net, or a custom HTTPS JSON endpoint. Cloudflare mode only guarantees a country code. GeoIP failures do not block metric reporting.

## Beta Agent actions

Each enabled Linux VPS has two buttons:

- "Run NQ": runs NodeQuality, saves the structured report, and shows the original report link.
- "Check IP unlock": runs the IPv4 full-report mode (`-4 -n -p`), saving a bounded full report and the final media-unlock results. The public page only shows media-unlock results.

An Agent can have one queued or running task at a time. States include queued, running, success, failed, and expired; queued tasks can be cancelled, running tasks can be force-stopped, and the Agent kills the whole script process group when it sees the cancel flag.

Buttons appear based on the capabilities the Agent reports, labeled `Manager active`, `compat mode`, `waiting for auto-update`, and similar. Old Agents with an existing root update channel migrate automatically.

The NQ "Network" and "Return Route" sections are rendered to self-contained SVGs by the Worker and uploaded through a fixed channel:

- Upload URL, API token, and channel name exist only in Worker Secrets.
- Only tasks created by an admin and completed by the matching Agent trigger uploads.
- Public reports return same-origin proxy URLs; the upstream host never reaches the browser.
- Upload failure does not fail the task; the UI falls back to the text report.

## Ping and latency

Agent TCP pings, External Latency Agents, and Cloudflare latency are independent. An online Agent does not mean Cloudflare can reach the target port.

## Notifications

Telegram and email both support test, enable/disable, format, and templates. Send a test before enabling rules for offline, recovery, resource, traffic, and expiry.

## Appearance

The built-in frontend supports site name, browser title, favicon, logo, header subtitle, header image or text, footer, colors, copy, and module visibility. Changes apply on the next public page refresh.

## Third-party themes

The "Themes" page accepts ZIPs conforming to `nie-sla-theme-v1`. Uploads are inactive by default; at most one theme is enabled at a time. CSS themes only change styles; Canvas themes run in an iframe without same-origin access and can only read desensitized public data. Plugins, marketplace imports, and arbitrary extension runtimes are not available. See the [third-party theme spec](13-third-party-themes.md).

## Backup and restore

Export a normal backup or a password-protected sensitive backup. Per-node Agent tokens in sensitive backups are re-wrapped with the current deployment's encryption material on restore, so nodes can authenticate against a new D1 without reinstall. Restore requires a preview and an explicit confirmation; merge and replace modes are supported, and the Worker keeps a pre-restore snapshot in R2.

Backup passwords need at least 10 characters. Normal backups contain no Agent tokens; high-frequency history is not in the JSON, so reuse the original R2 when migrating.

The "Settings → Agent → Agent connection domain" field accepts a public HTTPS origin routed to the current Worker that serves `/api`, install scripts, and `/bin`.
