# 15 Plugin Engineering Standard

NStatus plugins are sandboxed, read-only frontend panels. They are not Worker plugins or Admin extensions.

## Repository contract

Use an independent repository containing `src/index.html`, external JavaScript and CSS, `tests/`, `manifest.json`, `README.md`, `LICENSE`, `CHANGELOG.md`, and a generated `dist/`. Only `dist/` is packaged. All runtime assets must be local because server routes, CDNs, remote imports, and package-external resources are unavailable.

Provide equivalent `dev`, `build`, `typecheck`, `test`, and `package` scripts. `build` recreates `dist/`; `package` archives only `dist/` as `release/<id>-<version>.zip`.

## Manifest and security

The manifest uses `schema: nstatus-extension-v1`, a stable ID, SemVer, `type: plugin`, a packaged HTML `entry`, `permissions: ["status:read"]`, and height from 200 through 1200. No other v1 permission is valid.

Plugins run with `sandbox="allow-scripts"` and a CSP that blocks networking, inline scripts, forms, and top-level navigation. They cannot access the host DOM, browser storage, Admin or Agent tokens, management endpoints, or privileged writes.

## Coding and tests

- Accept status messages only from `parent` with the known `nstatus:status` type; ignore unknown messages and fields.
- Render API strings with `textContent` or equivalent safe DOM APIs, never untrusted `innerHTML`.
- Handle `null`, missing fields, empty arrays, repeated messages, and iframe disposal without unhandled errors.
- Keep rendering idempotent, keyboard accessible, focus visible, and WCAG AA compliant.
- Do not add fingerprinting, telemetry, advertising, mining, or persisted user data.
- Test origin filtering, XSS payloads, missing data, repeat delivery, resize bounds, narrow layouts, keyboard use, and offline CSP behavior.

Publish the license, source tag, changelog, reproducible build instructions, and ZIP SHA-256. Test type-separated upload rejection, disabled-by-default installation, enable/disable, upgrade, and deletion. Strip source-map paths, credentials, production data, `.env`, snapshots, and caches.

This standard borrows NodeGet's independent-module, manifest, command, and build-output conventions. The runtime is deliberately incompatible: NodeGet components must be rewritten as message-driven read-only panels without direct DOM, network, or write access.
