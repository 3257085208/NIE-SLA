# Deploy to Cloudflare

> This is an in-repository reference. The continuously maintained canonical guide is [NIE-SLA Quick Start](https://nie-sla.pages.dev/quickstart/).

The recommended deployment runs in the browser. Prepare a GitHub account, a Cloudflare account, and these values:

| Name | Value |
| --- | --- |
| `ADMIN_USERNAME` | Admin username, for example `admin` |
| `ADMIN_PASSWORD` | At least 9 characters with uppercase, lowercase, number, and special character |
| `ADMIN_PATH` | A 3-64 character route such as `/console-7f3a`, using letters, numbers, hyphens, or underscores |

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/3257085208/NIE-SLA)

Authorize GitHub and Cloudflare, enter the three values, and start the deployment. Internal tuning settings use fixed safe defaults and are not shown in the form. Cloudflare builds the Worker and frontend and creates D1, R2, the Durable Object, and the one-minute cron trigger.

If the result is `https://project.account.workers.dev`, append the configured `ADMIN_PATH` and sign in with the configured username and password. TOTP is disabled by default and can be enabled from Settings. Add a VPS under Agents and run the generated command on that VPS. The Worker creates a random credential for each Agent automatically; new deployments do not need a global `AGENT_TOKEN`.

One-click deployment uses the supplied `ADMIN_PATH` as the initial route. You can change it later under **Settings → Admin entry**. The old route returns 404 after the change, and GitHub OAuth follows the new route. Save the current URL immediately. A custom route reduces generic scan noise but does not replace password, session, or TOTP protection.

Current status uses a lightweight one-minute R2 layer. SLA history remains in five-minute D1 buckets to protect free-tier write capacity.

## Optional GitHub Login

Create a GitHub OAuth App under **Settings → Developer settings → OAuth Apps**. Set the callback URL to:

```text
https://your-status-domain.example/api/auth/github/callback
```

Then add these Worker variables/secrets in Cloudflare:

```text
GITHUB_OAUTH_CLIENT_ID
GITHUB_OAUTH_CLIENT_SECRET
GITHUB_OAUTH_ALLOWED_USERS
```

`GITHUB_OAUTH_ALLOWED_USERS` is a comma-separated list of GitHub usernames. GitHub login never grants access to users outside this list and still requires TOTP when TOTP is enabled.

## Optional Email Alerts

Verify a sending domain in Resend and create an API key. In **Settings → Alerts**, enable email, enter the Resend API key, sender, and recipients, save, and send a test email. Multiple recipients are comma-separated.

After login, **Settings → Administrator account** can migrate the initial environment credentials to a salted D1 password record. If the credentials are lost, run `npm run admin:reset -- --remote` from the `worker` directory after `npx wrangler login`; add `--disable-totp` only when the second factor is also unavailable.

## Upgrade Compatibility

On an existing deployment, the default username is `admin`. If `ADMIN_PASSWORD` is not set yet, the existing `ADMIN_TOKEN` is accepted as the temporary password. Set a dedicated `ADMIN_PASSWORD` after the upgrade.

Starting with `1.0.21`, one-click installations expose **Settings → System update**. It shows the installed and latest application versions, publication time, and changelog. Before the first online update:

1. In the deployment repository, allow read and write workflow permissions under **Settings → Actions → General**.
2. Create a fine-grained GitHub personal access token scoped only to that repository with `Actions: Read and write`.
3. Enter the deployment repository as `owner/repo`, paste the one-time token, and start the update.
4. Follow the provided GitHub Actions link. The workflow builds, tests, and performs a Wrangler dry run before it pushes anything; Cloudflare then redeploys the new commit automatically.

The token is sent to GitHub for that request only and is never stored in D1, Worker variables, or the browser. The workflow always restores the deployment repository's existing `wrangler.jsonc`, preserving its D1, R2, and Durable Object bindings. Installations older than `1.0.21` need one manual upstream sync before the update center can be used.

See [Admin](03-admin.md), [Agent](04-agent.md), [Alerts](06-alerts.md), [External Latency Agents](12-external-latency-agents.md), and [Extensions](13-extensions-developer-guide.md).
