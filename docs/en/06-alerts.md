# 06 Alerts

Worker cron evaluates alert rules every minute. Telegram and email share the same thresholds, recovery notifications, repeat cooldown, and D1 deduplication state.

Supported rules include Agent offline/recovery, Cloudflare probe failure/recovery, CPU, memory, disk, load, disk and network rates, process/thread count, expiry, and remaining traffic.

## Telegram

Create a bot with `@BotFather`, obtain the token and chat ID, then configure Telegram under **Settings → Alerts**. Tokens saved in Admin are encrypted with `ALERT_ENCRYPTION_KEY` or `TOTP_ENCRYPTION_KEY`. The `TELEGRAM_BOT_TOKEN` Worker secret is also supported.

## Email

Email uses the Resend HTTPS API. Verify a sending domain, create an API key, enable email in Admin, and enter the API key, sender, and comma-separated recipients. Senders may use `NIE-SLA <status@example.com>` format.

Environment configuration is also supported through `RESEND_API_KEY`, `ALERT_EMAIL_FROM`, `ALERT_EMAIL_TO`, and `ALERT_EMAIL_REPLY_TO`.

## Formats and templates

Telegram supports plain text, HTML, and MarkdownV2, plus Topic/Thread ID, silent delivery, and link-preview control. Email supports separate subject/body templates and plain-text or HTML bodies.

Both channels support `{{title}}`, `{{message}}`, `{{site_name}}`, `{{time}}`, `{{alert_count}}`, and `{{channel}}`. Dynamic values are escaped for the selected markup format. Templates cannot change the destination URL or authentication headers: Telegram remains restricted to the official Bot API and email to Resend.

Telegram and email body templates must contain exactly one `{{message}}`; every other placeholder may also appear at most once. Unknown or repeated placeholders are rejected when settings are saved, preventing oversized messages and broken markup.

## Timing

The current-status layer probes about once per minute and merges one R2 state object. SLA history remains in five-minute D1 buckets. This gives faster status and alerts without multiplying persistent SLA writes.

If both channels are enabled, a successful delivery to either channel commits deduplication state. A failed channel is recorded in the last run result without causing the healthy channel to resend every minute.
