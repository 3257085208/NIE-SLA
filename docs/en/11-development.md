# Development, testing, and release

## Production sources

The Rust Agent and Worker live in this repository; the production frontend lives in the sibling `frontend/` repository. The public repository is generated one-way by `scripts/export-public.mjs`; never overwrite production sources from the public copy or archives.

## Testing

```bash
bash test.sh
```

Covers Worker syntax and packaging, auth, task whitelist, GeoIP, backup/restore, frontend modules, Rust fmt/check/test, installers, and shell syntax.

## Local Agent release

```bash
cd agent
./build-release.sh
```

Builds five targets and writes a matching `VERSION` and `SHA256SUMS`. Then:

1. Compute the SHA-256 of `SHA256SUMS` itself.
2. Update the Linux installer defaults.
3. Sync the whole `bin/` batch to the production frontend `bin/`.
4. Run the full test suite.
5. Verify `--version` on every binary.
6. Create the GitHub Release.

## Worker and Static Assets

```bash
cd worker
./deploy.sh
```

Generates `dist-one-click` from the production frontend and deploys the Worker. The public one-click repository is built by `npm run build` at its root. Before release, check the artifacts contain no `AGENTS.md`, tests, Pages Functions, `node_modules`, or the removed generic extension runtime; public theme runtimes and examples must stay.

## Public export

```bash
node scripts/export-public.mjs          # dry-run
node scripts/export-public.mjs --apply  # write into the public repo
```

The exporter scans for production domains, tokens, private keys, and local paths, and replaces document domains with placeholders. The NQ public chain and executable scripts under `vendor/` keep their real addresses because public deployments need them to run.

## Versioning

- Application, Worker, and Agent share `X.Y.Z`; display, tags, and Agent releases use `vX.Y.Z`.
- Normal iterations bump the patch digit by `0.0.1`; breaking changes raise minor or major.
- App source tags use `app-vX.Y.Z`; Agent binaries and releases use `vX.Y.Z`. Both numbers must match.
- When GitHub Actions capacity is unavailable, Agent releases must be built locally on a trusted machine.
