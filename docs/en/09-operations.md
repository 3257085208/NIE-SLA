# Operations and Migration

Monitor Worker Cron, D1/R2 usage, last Agent reports, external Latency reports, and notification failures.

Before migration or a large update, export both portable and password-protected backups. Restore supports preview, merge or replace, and writes an automatic pre-restore R2 snapshot.

Portable JSON does not include full high-frequency history. Reuse the original R2 binding where possible.

For Beta task troubleshooting, verify the `nstatus-metrics-tasks` service and its journal. Re-run the latest per-node deployment command on older Linux installations.
