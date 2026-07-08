# 03 Admin Panel

## Login and TOTP

The admin panel is usually available at `https://your-frontend/admin.html`. Log in with `ADMIN_TOKEN`, then enable TOTP from Settings. TOTP secrets are encrypted with `TOTP_ENCRYPTION_KEY` before being stored in D1.

## Targets

A target represents a monitored service or VPS. Important fields include ID, name, group, type, host/port or URL/status codes, tags, location, expiry date, price, currency, billing cycle, per-VPS traffic settings, and per-VPS alert settings.

## Ping Targets

Ping targets are TCP endpoints tested by the Agent, such as `1.1.1.1:53` or `api.example.com:443`. The card theme displays all managed ping targets with colored latency bars.

## Themes

Settings can switch between the classic list and the card layout without removing the original UI.

## Install Commands

The Deploy button generates a per-target install command containing API base, download base, Agent token, Agent ID, and label. Do not publish generated commands because they contain secrets.
