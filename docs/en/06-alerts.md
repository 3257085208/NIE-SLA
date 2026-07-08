# 06 Telegram Alerts

Alerts are evaluated by Worker cron, not WebSocket. This keeps quota usage predictable and is accurate enough for minute-level offline detection.

## Setup

1. Create a bot with `@BotFather`.
2. Obtain the bot token.
3. Obtain a chat id for your user/group/channel.
4. Enter both in Settings -> Telegram Alerts. A bot token saved through the admin panel is encrypted before being written to D1; you can also use Worker secret `TELEGRAM_BOT_TOKEN`.
5. Send a test message.

## Alert Types

- Offline after N minutes without an Agent report.
- Optional online/recovery notification.
- CPU, memory, disk, load1, disk read/write, network rx/tx, process count, and thread count thresholds.
- Expiry N days before the configured expiry date.
- Traffic remaining below N% or N GB.

## Per-VPS Overrides

Each target can disable alerts or override expiry and traffic thresholds. Empty override fields use global settings.

## State and Cooldown

D1 table `alert_state` stores active/resolved status per target and rule. Repeat cooldown prevents Telegram spam while an alert remains active.
