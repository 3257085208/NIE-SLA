# 03 Admin Panel

## Login and TOTP

The admin panel is usually available at `https://your-frontend/admin.html`. Log in with `ADMIN_TOKEN`, then enable TOTP from Settings. TOTP secrets are encrypted with `TOTP_ENCRYPTION_KEY` before being stored in D1.

## Targets

A target represents a monitored service or VPS. Important fields include ID, name, group, type, host/port or URL/status codes, tags, location, expiry date, price, currency, billing cycle, per-VPS traffic settings, and per-VPS alert settings.

### NodeQuality reports

When editing a TCP/VPS target, paste the original NodeQuality Markdown report into the `NodeQuality report` field and save it. The Worker parses `:::: tabs` reports into hardware/basic information, IP quality, network quality, and return-route tabs. ANSI text keeps terminal colors, while network and route tabs keep their report images. Submit the field empty to remove the report.

An enabled TCP/VPS target with a report gets an `NQ` button on the public VPS list. The modal loads the parsed report, shows the extracted report time, and links to the original report. HTTP targets never expose this button.

### Agent-only availability

Targets marked `No public IP` use Agent heartbeat availability instead of Cloudflare probe success for their daily blocks. Heartbeat gaps beyond `AGENT_OFFLINE_AFTER_SEC` are counted as downtime and split at local-day boundaries. On upgrade, the Worker conservatively bootstraps only the interval proven by the target creation time and the Agent's current system uptime; once the daily ledger starts, real heartbeat data is authoritative and unknown history remains gray.

## Ping Targets

Ping targets are TCP endpoints tested by the Agent, such as `1.1.1.1:53` or `api.example.com:443`. The card theme displays all managed ping targets with colored latency bars.

## Themes

The classic list is built in. Additional layouts, including the official card theme example, are installed as validated theme ZIPs from the dedicated Themes page.

## Install Commands

The Deploy button generates a per-target install command containing API base, download base, Agent token, Agent ID, and label. Do not publish generated commands because they contain secrets.
