# 09 Operations and Troubleshooting

## Routine Checks

Run `./test.sh`, verify Worker health, open the dashboard, and check Agent status from the admin panel.

## Missing Agent Version

Update the Agent, restart `nstatus-metrics`, and ensure the Worker supports `agent_version`.

## Traffic Stays at Zero

Ensure Agent ID equals target ID, traffic is enabled for that VPS, quota is set, and the Agent has reported at least twice in the same traffic period.

## Install Command 404

Verify Pages deployed `install.sh`, `PUBLIC_AGENT_INSTALL_BASE` points to the frontend domain, and old temporary Pages URLs are not used.

## sudo Not Found

If you are already root, sudo is unnecessary. Use the current admin-generated command, which detects root automatically.

## Telegram Not Sending

Check the global alert switch, token, chat id, per-VPS alert switch, cooldown, and Worker cron execution.
