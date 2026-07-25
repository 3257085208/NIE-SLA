# Deploy to Cloudflare

The recommended deployment runs in the browser. Prepare a GitHub account, a Cloudflare account, and these values:

The project supports a separate Pages frontend and Worker API, but Cloudflare's deploy button currently supports Workers applications only. This flow therefore serves the frontend through Workers Static Assets on the same Worker as the API. It produces one `workers.dev` entry point and does not require a separate Pages project.

| Name | Value |
| --- | --- |
| `ADMIN_USERNAME` | Admin username, for example `admin` |
| `ADMIN_PASSWORD` | Unique password with at least 20 characters |
| `AGENT_TOKEN` | Independent random value of at least 32 bytes |
| `TOTP_ENCRYPTION_KEY` | A different random value of at least 32 bytes |

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/3257085208/NIE-SLA)

Authorize GitHub and Cloudflare, enter the four values, and start the deployment. Cloudflare builds the Worker and frontend and creates D1, R2, the Durable Object, and the one-minute cron trigger.

If the result is `https://project.account.workers.dev`, open `https://project.account.workers.dev/admin` and sign in with the configured username and password. Enable TOTP from Settings, add a VPS under Agents, and run the generated command on that VPS.

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

See [Admin](03-admin.md), [Agent](04-agent.md), [Alerts](06-alerts.md), [External Latency Agents](12-external-latency-agents.md), and [Extensions](13-extensions-developer-guide.md).
