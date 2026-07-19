# AGENTS.md — agent/ (production Agent + Worker)

GitHub: `3257085208/NIE-SLA-Agent` (private)

This folder lives at `NIE-SLA/agent` on the local umbrella workspace.

## Scope

- Edit **Agent** under `agent/`
- Edit **Worker** under `worker/`
- Deploy Worker only from `worker/`: `npx wrangler deploy`
- Agent releases: git tag `v*` + CI
- Frontend production is **sibling** `../frontend` (CloudflareStatus), not this tree's possibly-stale `frontend/`

## Forbidden

- Do not deploy from `../_archive`
- Do not reverse-sync from `../public`
- Do not push/deploy unless the user asks


## Security / cost guards (2026-07)

- Public metrics/pings reject unlimited history (`max_points<=0` maps to defaults).
- Production frontend is sibling `../frontend`; local `frontend/` is deprecated.
- Windows installer prefers AtStartup + SYSTEM when elevated.


## Auth (2026-07 full fix)

- With TOTP enabled, admin APIs require `x-admin-session` only (no master token on each request).
- Login/TOTP setup/verify still use `ADMIN_TOKEN`.
- CORS uses `ALLOWED_ORIGIN` / `PUBLIC_SITE_ORIGIN` (not *).
- After deploy: `node scripts/smoke-prod.mjs`
