# Admin Panel

The admin panel uses username/password sessions with optional GitHub OAuth and TOTP. Changing the admin path invalidates the old route; the path is not an authentication secret.

VPS records keep provider or custom provider, machine type, tags, pricing, expiry, independent traffic reset day, quota, and alert rules. Country and city are read-only Agent GeoIP results.

GeoIP providers are IP.SB, Cloudflare, IPIP.net, or a custom public HTTPS JSON endpoint.

Two explicitly triggered Linux actions are marked Beta:

- NodeQuality stores only an allowed report URL.
- IPv4 unlock stores only selected media-unlock fields.

No arbitrary command, URL, arguments, stdin, or schedule is accepted.

Telegram and email, appearance settings, updates, and backup/restore remain available.

The **Themes** page accepts `nie-sla-theme-v1` ZIP packages. New and replacement uploads remain disabled until explicitly enabled. CSS themes style the built-in public page without JavaScript. Canvas themes own the full public layout but run in an iframe without same-origin privileges and receive only redacted read-only data. ZIP SHA-256 is verified by both browser and Worker. Plugins and arbitrary extension runtimes remain unavailable. See [Third-Party Theme Specification](13-third-party-themes.md).
