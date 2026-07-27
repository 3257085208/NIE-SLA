# Contributing to NIE-SLA

## Project Structure

```text
NIE-SLA/
|-- worker/          Cloudflare Worker backend API
|   `-- src/         ES module sources
|-- frontend/        Cloudflare Pages status dashboard
|-- agent/           Rust metrics Agent and install scripts
|   |-- src/         Rust Agent source
|   |-- bin/         Release binaries served by Agent Pages
|   |-- cftz         Agent manager CLI
|   `-- setup.sh     One-line installer backend
|-- docs/            Documentation
`-- test.sh          Smoke test runner
```

## Quick Start

```bash
# Backend
cd worker && npx wrangler deploy

# Frontend
cd frontend && npx wrangler pages deploy ./ --project-name=nstatus

# Agent
cd agent && cargo fmt -- --check && cargo check
cd agent && make build-linux
```

## Code Conventions

- **JS**: ES modules, no semicolons, 2-space indent.
- **Rust**: `cargo fmt`, small std-first dependencies, no inbound listener in the Agent.
- **Shell**: `set -euo pipefail`, Bash 4+ for management scripts, POSIX sh for `install.sh`.

## Testing

```bash
bash test.sh
```

The smoke test checks Worker JS, frontend JS, Rust formatting/checks, a Linux amd64 Agent build, and shell syntax.

## Release Process

1. Update Agent version in `agent/Cargo.toml` when the Agent protocol changes.
2. Update Worker/frontend version files when the API/UI changes.
3. Tag with `git tag v1.x.x && git push --tags`.
4. Build and verify the five supported Linux Agent architectures locally, then attach the binaries and SHA-256 manifest to the GitHub Release.
