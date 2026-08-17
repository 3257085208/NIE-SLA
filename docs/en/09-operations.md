# Operations, backup, and migration

## Routine checks

```bash
curl -fsSL https://YOUR-DOMAIN/api/health
curl -fsSL https://YOUR-DOMAIN/bin/VERSION
curl -fsSL https://YOUR-DOMAIN/bin/SHA256SUMS
```

Also check: cron run records, D1/R2 usage, Agent online state and versions, notification failures, and the last report times of external latency agents.

## Backups

Export both a normal and a sensitive backup before: switching deployment architecture, changing D1/R2 bindings, bulk-editing nodes, major upgrades, or changing Cloudflare accounts.

Sensitive backups include per-node Agent tokens by default. Tokens live only inside the password-encrypted package and are re-wrapped with the new deployment's encryption material on restore, so cross-account moves or D1 rebuilds do not require reinstalling Agents. Unchecking "keep credentials" produces a normal backup without tokens. Keep the password separate from the file; no JSON backup contains R2 history.

## Restore

1. Pick the backup file.
2. Enter the sensitive backup password.
3. Preview and check record counts.
4. Choose merge or replace.
5. Type the confirmation word.
6. Run the restore.
7. Check the pre-restore snapshot in R2.
8. Verify node IDs, Agent credentials, notifications, and appearance.

If a restore fails, do not click repeatedly. Keep the R2 snapshot and check Worker logs first.

## Migration from Pages + Worker

Within one account, bind the original D1 and R2 to the single Worker and keep the Agent API hostname; Agents keep working and high-frequency history survives.

Across accounts: deploy an empty control plane, restore the sensitive backup, then migrate R2 separately. The restore confirmation shows how many Agent tokens are migratable; keep the old deployment until done.

Setting "Settings → Agent → Agent connection domain" to an HTTPS origin routed to the new Worker lets install, API, and updates bypass the default `workers.dev`. The origin must not contain a path, query string, or credentials, and must serve `/api`, `/install.sh`, and `/bin`.

## Beta task troubleshooting

Buttons stuck queued: outdated Agent, missing root channel, or unreachable API hostname. Re-run the node's latest install command, then check:

```bash
sudo systemctl status nie-sla-agent --no-pager
sudo cftz status
sudo cftz log 100
```

NQ failures usually come from system permissions, missing dependencies, script timeout, or upstream unavailability; IP unlock failures from upstream format changes or a VPS without usable IPv4.
