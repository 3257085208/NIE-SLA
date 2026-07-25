# 11 Development and Release

## Layout

```text
agent/      Rust Agent and installers
frontend/   Pages dashboard/admin/install assets
worker/     Worker API and storage logic
docs/       Bilingual guides
tests/      Smoke tests
```

## Validation

```bash
./test.sh
```

## Deploy

```bash
cd worker && npx wrangler deploy
cd frontend && npx wrangler pages deploy ./ --project-name=nstatus --commit-dirty=true
```

## Release Order

Deploy Worker schema/API first, then Pages, then Agent binaries. Test on one VPS before rolling out broadly.

Build all Agent release artifacts on a trusted local machine while GitHub Actions capacity is unavailable:

```bash
cd agent
./build-release.sh
```

The script cross-compiles five static Linux targets and Windows amd64 with Zig, then creates a matching `bin/VERSION` and `bin/SHA256SUMS` only after every target succeeds.

The private Agent workflow is manual-only while Actions capacity is unavailable, so pushes, pull requests, and tags do not start remote builds. Restore those triggers when CI capacity returns.

## Commit Hygiene

Do not commit secrets, real target seed data, `.wrangler`, `.env`, `agent/target`, or generated logs. Update docs whenever API, Agent fields, or admin behavior changes.
