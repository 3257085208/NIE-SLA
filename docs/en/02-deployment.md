# Deploy to Cloudflare

The recommended installation runs entirely in the browser. You do not need a VPS, Node.js, Wrangler, or a local terminal for the control plane.

## Before You Start

Prepare:

- A Cloudflare account.
- A GitHub account.
- Three different random values, each at least 32 bytes long.

| Secret | Purpose |
| --- | --- |
| `ADMIN_TOKEN` | Admin login |
| `AGENT_TOKEN` | Derives a separate credential for each Agent |
| `TOTP_ENCRYPTION_KEY` | Encrypts TOTP secrets |

Store them in a password manager. Do not post them in issues, screenshots, forums, or public repositories.

## 1. Open the Deploy Page

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/3257085208/NIE-SLA)

## 2. Authorize GitHub and Cloudflare

Follow the page prompts to sign in to GitHub, allow Cloudflare to fork the repository, sign in to Cloudflare, and select the target account.

## 3. Enter the Secrets

Paste the three different values into:

```text
ADMIN_TOKEN
AGENT_TOKEN
TOTP_ENCRYPTION_KEY
```

Cloudflare stores them as Secrets. They are not committed to the repository.

## 4. Wait for Deployment

Cloudflare creates the Worker, D1 database, R2 bucket, Durable Object, cron trigger, Agent release assets, status page, and admin panel. When the build succeeds, open the provided `workers.dev` URL.

## 5. Open the Admin Panel

If the status page is:

```text
https://your-project.your-account.workers.dev
```

the admin panel is:

```text
https://your-project.your-account.workers.dev/admin
```

Log in with `ADMIN_TOKEN`. Enabling TOTP after the first login is recommended.

## 6. Add a VPS

In Admin:

1. Open **Agents**.
2. Add a target with its name, host, and port.
3. Save it and open its deployment action.
4. Choose Linux or Windows.
5. Run the generated command on that VPS.

Each command contains a node-specific credential. Do not reuse one node's command on another machine or publish the full command.

The public page will show metrics after the first successful report. Cloudflare availability checks and Agent reports are independent monitoring paths.

## Optional Setup

The admin UI includes site appearance, TOTP, Telegram alerts, traffic and billing data, Ping targets, external Latency Agents, NodeQuality reports, themes, and plugins. Configure them after the first node reports successfully.

To use a custom domain, open the deployed Worker in Cloudflare Dashboard and add it under **Domains & Routes**. The status page and `/admin` continue to use the same origin.

## Updates

The deploy flow creates a GitHub fork. Sync its `main` branch with upstream, then redeploy the latest commit from Cloudflare. Agent automatic updates are controlled from Admin and should be tested on one VPS first.

## Troubleshooting

- Build failure: open the Cloudflare build log and fix the first error, then redeploy.
- No Agent data: verify the command was run on the matching VPS, then use `sudo cftz status` and `sudo cftz log 100`.
- External Latency Agent not reporting: run its generated deployment command and confirm that the response contains `accepted` greater than zero.

See [Admin](03-admin.md), [Agent](04-agent.md), [Alerts](06-alerts.md), [External Latency Agents](12-external-latency-agents.md), and [Extensions](13-extensions-developer-guide.md) for feature-specific instructions.
