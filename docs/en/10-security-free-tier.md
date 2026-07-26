# Security and Free Tier

NIE-SLA uses short-lived admin sessions, optional OAuth allowlists and TOTP, per-Agent scoped tokens, outbound-only Agent transport, public payload redaction, and checksum-pinned updates.

There is no Web Shell or arbitrary scheduled command execution. The separate root runner accepts only two fixed Beta action identifiers. Theme/plugin upload and package execution are removed.

Sensitive backups use PBKDF2-SHA256 and AES-256-GCM. Custom GeoIP URLs require public HTTPS and reject explicit local, private, and metadata targets.

The free-tier design uses minute-level lightweight state, aggregated D1 SLA buckets, low-write daily traffic records, and R2 for high-frequency metrics. Monitor actual Workers, D1, R2, and Durable Objects usage; traffic and visitor patterns can dominate theoretical node limits.
