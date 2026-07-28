# Security and Free Tier

NIE-SLA uses short-lived admin sessions, optional OAuth allowlists and TOTP, per-Agent scoped tokens, outbound-only Agent transport, public payload redaction, and checksum-pinned updates.

Third-party CSS themes cannot execute JavaScript. Canvas themes run in an iframe without same-origin privileges, with a restrictive CSP and only the `status:read` message bridge. Theme ZIP size, file count, paths, extensions, manifest, and SHA-256 are validated; every upload is disabled pending administrator approval. Plugins, admin scripts, marketplace imports, and arbitrary extension execution remain unavailable.

There is no Web Shell or arbitrary scheduled command execution. The permanent root Manager accepts only action identifiers supported by both the Worker policy and its compiled binary. It never accepts command text, a URL, arguments, stdin, environment, or a schedule. Task subprocesses start with a cleared Agent environment and bounded download size, time, and captured output.

The NodeQuality and IP.Check.Place actions still download and execute the current scripts and transitive dependencies supplied by those services. This is an explicit external trust boundary of the two opt-in Beta actions; monitoring does not depend on them. Agent manifest hashes are supplied by the same Worker update policy, which detects transport corruption and mismatched artifacts but is not an independent offline release signature. A compromised Worker or release environment remains an operational risk.

Sensitive backups use PBKDF2-SHA256 and AES-256-GCM. Custom GeoIP URLs require public HTTPS and reject explicit local, private, and metadata targets.

The free-tier design uses minute-level lightweight state, aggregated D1 SLA buckets, low-write daily traffic records, and R2 for high-frequency metrics. Monitor actual Workers, D1, R2, and Durable Objects usage; traffic and visitor patterns can dominate theoretical node limits.
