# Alerts

The Worker evaluates alert rules every minute. Telegram and email share thresholds, recovery notifications, repeat cooldown, and D1 deduplication state.

## Rules

- Agent offline and recovery.
- Cloudflare check failure, interruption, and recovery.
- CPU, memory, disk, load1.
- Disk read/write, network up/down.
- Process and thread counts.
- VPS expiry date.
- Traffic remaining percent or GB.

A resource threshold of `0` disables that rule. Each VPS can disable alerts or override the expiry and traffic thresholds.

## Telegram

1. Create a bot with `@BotFather` and get the token.
2. Add the bot to a chat, group, or channel and get the Chat ID.
3. Enable Telegram under "Settings → Alert notifications" and enter token and Chat ID.
4. Save and click "Test Telegram".

The token can live in the `TELEGRAM_BOT_TOKEN` Worker secret or in the admin UI. UI-stored credentials use the long-term `ALERT_ENCRYPTION_KEY`, falling back to `TOTP_ENCRYPTION_KEY`. Plain text, HTML, and MarkdownV2 are supported, plus group topics, silent sends, link previews, and per-channel templates.

## Email

Email goes through the Resend HTTPS API, not SMTP:

1. Register with Resend, verify a sending domain, and create an API key.
2. Enable email notifications and enter the API key, from, and recipients.
3. Save and click "Test email".

Example sender: `NIE-SLA <status@example.com>`. Multiple recipients are comma-separated, up to 10 valid addresses. The key can also be set as `RESEND_API_KEY` with `ALERT_EMAIL_FROM`, `ALERT_EMAIL_TO`, and `ALERT_EMAIL_REPLY_TO`. Subject and body templates are independent; HTML mode escapes dynamic alert content but keeps admin-written template markup.

## Templates

Placeholders:

| Placeholder | Content |
| --- | --- |
| `{{title}}` | batch title |
| `{{message}}` | alert or test body |
| `{{site_name}}` | site name |
| `{{time}}` | send time |
| `{{alert_count}}` | number of alerts in the batch |
| `{{channel}}` | `telegram` or `email` |

The body must contain exactly one `{{message}}`, and each other placeholder may appear once; unknown or duplicate placeholders are rejected on save. Templates cannot execute JavaScript or change the request URL, auth header, or recipients. Telegram always targets the official Bot API and email always the Resend API.

## Granularity and deduplication

The cron runs every minute; current check results come from the merged R2 state, so alerts are usually visible at roughly one-minute granularity. Daily grids, SLA, and long-term stats use 5-minute D1 buckets. With `FAST_STATUS_ENABLED` off, check alerts fall back to the 5-minute persistence granularity.

Each rule keeps state per `target_id + rule_key`: normal → triggered → active → recovered → normal. An active alert repeats only after the cooldown. When both channels are enabled, the Worker sends the same batch to both and commits deduplication state as soon as one channel succeeds; the failing channel is recorded in the last run result.

## Troubleshooting

- Tests pass but rules never fire: check thresholds, per-VPS switches, and cooldown.
- Telegram fails: token, Chat ID, bot permissions in the group.
- Email fails: domain verification, API key, sender domain.
- Check alerts are slow: confirm `FAST_STATUS_ENABLED=true`, look at the last cron result.
- Agent offline alerts are slow: lower "offline after N minutes", but not below normal reporting jitter.

Never post bot tokens, Resend keys, full install commands, or admin credentials in logs, issues, or screenshots.
