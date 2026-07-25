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

Starting with `1.0.22`, each one-click deployment repository checks the official stable version every six hours. When an update is available, the workflow preserves the existing `wrangler.jsonc`, runs security checks, application tests, and a Wrangler dry run, then commits the verified update for Cloudflare to redeploy. No repository name, GitHub token, or Cloudflare token is requested.

To check immediately, open the generated repository, select **Actions → NIE-SLA Online Update**, and click **Run workflow** without entering any parameters. **Settings → System update** shows version information and opens the changelog and instructions in local dialogs. If GitHub reports a push permission error, enable read/write workflow permission under **Settings → Actions → General**. Installations older than `1.0.22` need one manual upstream sync to receive the no-input workflow.

See [Admin](03-admin.md), [Agent](04-agent.md), [Alerts](06-alerts.md), [External Latency Agents](12-external-latency-agents.md), and [Extensions](13-extensions-developer-guide.md).
