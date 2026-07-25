# 03 Admin Panel

## Login and TOTP

The admin panel is usually available at `https://your-frontend/admin`. Log in with `ADMIN_USERNAME` and `ADMIN_PASSWORD`. TOTP is disabled by default and can be enabled from Settings. Passwords are only sent to the login endpoint; admin APIs use a short-lived session whose hash is stored in D1. Optional GitHub OAuth uses an explicit username allowlist and cannot bypass TOTP. TOTP secrets use the optional `TOTP_ENCRYPTION_KEY`, falling back to the deployment `ADMIN_PASSWORD`, before storage in D1.

## Custom admin route

Use **Settings → Admin entry** to replace `/admin` with a single path such as `/console-7f3a`. The value must contain 3-64 letters, digits, hyphens, or underscores and cannot use reserved API or asset paths. After saving, `/admin`, `/admin/`, and `/admin.html` return 404, while GitHub OAuth returns to the new route.

For split Pages deployments, keep the root Pages Function and configure `NSTATUS_API_BASE` so Pages can resolve the current route. The route is discoverable by the client routing layer and is not an authentication secret; passwords, short-lived sessions, rate limits, and optional TOTP remain the security boundary.

## Application updates

**Settings → System update** displays the current application version, latest stable version, publication time, and changelog. Application releases use `app-v*` tags and are separate from the Agent binary `v*` releases.

A Worker cannot rewrite its own deployment without control-plane authorization. The online update button therefore dispatches the `NIE-SLA Online Update` workflow in the user's deployment repository. The workflow merges the official stable application tag while retaining the repository's `wrangler.jsonc` resource bindings, then runs the build, tests, security checks, and Wrangler dry-run before pushing. Cloudflare deploys that tested commit and keeps the previous successful deployment until the new build succeeds.

Enable Actions and grant workflow read/write permission under **Settings → Actions → General**. At update time, enter the deployment repository as `owner/repo` and a fine-grained GitHub token limited to that repository with Actions write access. The token is used for that dispatch request only and is never stored in D1, Worker variables, logs, or browser storage. Deployments older than `1.0.20` need one manual synchronization before this workflow becomes available.

## Targets

A target represents a monitored service or VPS. Important fields include ID, name, group, type, host/port or URL/status codes, tags, location, expiry date, price, currency, billing cycle, per-VPS traffic settings, and per-VPS alert settings.

### Machine type

Machine type is a display and grouping label; it does not alter the probe protocol or Agent behavior. Built-in choices cover web hosting, optimized-route, egress, relay, residential, unblocking, storage, backup, compute, game, mail, general-purpose, and other machines. The field may remain empty. Legacy Chinese values remain visible and selectable when existing targets are edited.

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
# Administrator credentials

Use **Settings → Administrator account** to change the username and password. The current password is required, and an active TOTP code is also required when TOTP is enabled. New passwords must contain at least 9 characters, including uppercase, lowercase, a number, and a special character. The new password is stored as a randomly salted PBKDF2-SHA256 record in D1; plaintext credentials are never stored. Other admin sessions are revoked after a successful change.

For lockout recovery, use the Cloudflare control plane from a trusted machine:

```bash
cd worker
npm install
npx wrangler login
npm run admin:reset -- --remote
```

Add `--disable-totp` only when the TOTP secret has also been lost. The tool never accepts a password command-line argument, keeping it out of shell history and process listings.
