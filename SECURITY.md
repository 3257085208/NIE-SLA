# Security Policy

## Supported Version

Security fixes target the current `main` branch and latest GitHub Release. Upgrade Worker, frontend, and Agent together before reporting an issue that only affects an older release.

## Private Reporting

Do not open a public Issue for a vulnerability that exposes authentication, another deployment, or private infrastructure. Use GitHub Security Advisories for this repository when available, or contact the repository owner through a private channel listed on their GitHub profile.

Include the affected commit/version, minimal reproduction, impact, and suggested mitigation. Remove real Token values, TOTP secrets, Telegram credentials, Cloudflare IDs, domains, IP addresses, Agent install commands, and production payloads.

## Deployment Responsibilities

- Generate independent random values for `ADMIN_TOKEN`, `AGENT_TOKEN`, and encryption keys.
- Keep secrets in Wrangler Secrets, never `[vars]`, `.env`, source files, screenshots, or Issue logs.
- Enable TOTP for administrative access.
- Use HTTPS for every public Worker, Pages, and Agent endpoint.
- Use the scoped Token generated for each target; never distribute the global Agent Token.
- Validate GitHub Release checksums and pin the manifest hash in generated install commands.
- Review Cloudflare access logs, D1/R2 usage, and dependency updates regularly.

The repository includes `tests/public-repo-safety.test.mjs` to detect common accidental disclosures. It supplements review and secret scanning; it is not proof that a deployment is secure.
