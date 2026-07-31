# Operations and Migration

Monitor Worker Cron, D1/R2 usage, last Agent reports, external Latency reports, and notification failures.

Before migration or a large update, export the password-protected backup, which is selected by default. It carries per-node Agent tokens only inside the password-encrypted envelope and re-wraps them with the destination deployment key during restore. Existing Agents therefore keep reporting after a new D1 is created. An unprotected portable export deliberately omits credentials.

Portable JSON does not include full high-frequency history. Reuse the original R2 binding where possible.

Set **Settings → Agent → Agent connection domain** to a public HTTPS origin already routed to the Worker when `workers.dev` is unsuitable. The origin must serve `/api`, installer scripts, and `/bin`, and cannot contain credentials, a path, query, or fragment.

For Beta task troubleshooting, verify the `nstatus-metrics-tasks` service and its journal. Re-run the latest per-node deployment command on older Linux installations.
