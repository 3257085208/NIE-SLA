# Admin Panel

The admin panel uses username/password sessions with optional GitHub OAuth and TOTP. Changing the admin path invalidates the old route; the path is not an authentication secret.

VPS records keep provider or custom provider, machine type, tags, pricing, expiry, independent traffic reset day, quota, and alert rules. Country and city are read-only Agent GeoIP results.

GeoIP providers are IP.SB, Cloudflare, IPIP.net, or a custom public HTTPS JSON endpoint.

Two explicitly triggered Linux actions are marked Beta:

- NodeQuality stores a normalized report and an allow-listed report URL.
- IPv4 unlock stores only selected media-unlock fields.

No arbitrary command, URL, arguments, stdin, or schedule is accepted.

The Worker can render the Network Quality and Return Route sections as self-contained SVG images and upload them through a fixed S3 channel with no upload folder. There is no admin image-host card, configuration route, test route, or general-purpose upload proxy.

The endpoint, API token, and optional S3 channel name stay in Worker Secrets and are never returned to an Agent or browser. Only an administrator-created NQ task completed by the authenticated matching Agent can trigger an upload. Public reports expose a same-origin NIE-SLA image proxy instead of the upstream image URL. Upload failures keep the NQ task successful and the UI falls back to the stored text report.

Telegram and email, appearance settings, updates, and backup/restore remain available. Protected backup is selected by default and re-wraps per-node Agent tokens under the destination deployment key. The Agent panel also accepts one public HTTPS Worker origin for installer, API, Latency Agent, and update URLs.

The **Themes** page accepts `nie-sla-theme-v1` ZIP packages. New and replacement uploads remain disabled until explicitly enabled. CSS themes style the built-in public page without JavaScript. Canvas themes own the full public layout but run in an iframe without same-origin privileges and receive only redacted read-only data. ZIP SHA-256 is verified by both browser and Worker. Plugins and arbitrary extension runtimes remain unavailable. See [Third-Party Theme Specification](13-third-party-themes.md).
