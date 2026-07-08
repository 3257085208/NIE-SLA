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

## Commit Hygiene

Do not commit secrets, real target seed data, `.wrangler`, `.env`, `agent/target`, or generated logs. Update docs whenever API, Agent fields, or admin behavior changes.
