# AGENTS.md — public/ (desensitized showcase)

GitHub: `3257085208/NIE-SLA` (public)

This folder is the public, non-production snapshot inside the local NIE-SLA umbrella workspace.

## Scope

- Keep only desensitized Agent, Worker, frontend, tests, and documentation
- Accept updates only from `../agent` and `../frontend` through the one-way export workflow
- Keep deployment identifiers, production domains, tokens, and private infrastructure data out
- Preserve public-only README, SECURITY, badges, and repository guidance

## Forbidden

- Never copy files from this repository into `../agent` or `../frontend`
- Never deploy Worker or Pages from this repository
- Never add real Cloudflare database IDs, bucket names, routes, API domains, or credentials
- Do not push unless the user asks

## Validation

- Run `node tests/public-repo-safety.test.mjs` after every export
- Run `test.sh` before pushing the public snapshot
