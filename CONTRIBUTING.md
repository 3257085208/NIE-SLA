# Contributing to NIE-SLA

Thanks for your interest in contributing!

## Code Conventions

### JavaScript (Worker / Frontend)

- Use modern ES module syntax (`import`/`export`)
- Prefer `async/await` over raw promises
- Keep functions small and single-purpose
- Use consistent 2-space indentation
- No trailing semicolons (project convention)
- Worker source uses CommonJS-like `export` but runs as ES modules

### Rust (Agent)

- Follow standard `cargo fmt` output
- Keep `main.rs` organized with clear section comments
- Use `ureq` for HTTP, `sysinfo` for system data
- Avoid `unsafe` blocks

### Shell Scripts

- All install scripts must pass `bash -n` (syntax check)
- Use `set -euo pipefail`
- Support both `curl` and `wget` for downloads
- Quote all variable expansions

## Testing

Run the full test suite before submitting:

```bash
./test.sh
```

This checks: Worker JS syntax, frontend JS syntax, Rust fmt/check/build, shell script syntax, and repository hygiene.

## Pull Request Process

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/my-feature`)
3. Make your changes
4. Run `./test.sh` and ensure all tests pass
5. Commit with a descriptive message
6. Push and open a PR

## Release Process

### Agent Release

1. Update `agent/Cargo.toml` version
2. Update `agent/VERSION` file
3. Update `worker/src/version.js`
4. Push a tag: `git tag v1.x.x && git push --tags`
5. GitHub Actions will build all platforms and create a Release

### Worker Release

```bash
cd worker
npx wrangler deploy
```

### Frontend Release

```bash
cd frontend
npx wrangler pages deploy ./ --project-name=nstatus
```

## Security

If you discover a security vulnerability, please do NOT open a public issue. Contact the maintainers directly.

## Code of Conduct

Be respectful. Be constructive. Help make this project better for everyone.
