# 14 Theme Engineering Standard

This document defines the source-to-ZIP contract for third-party NStatus themes. Read [13 Extensions and Developer API](13-extensions-developer-guide.md) for the platform package and API contract.

## Repository contract

Maintain each theme in an independent repository with `src/`, `tests/`, `manifest.json`, `README.md`, `LICENSE`, `CHANGELOG.md`, and a generated `dist/` directory. Only `dist/` may be packaged; `dist/manifest.json` must be at the ZIP root. Never ship source caches, credentials, `.env`, private infrastructure, or `node_modules`.

Required equivalent commands are `npm run dev`, `npm run build`, `npm run typecheck`, `npm test`, and `npm run package`. `build` must recreate `dist/`; `package` must create `release/<id>-<version>.zip` from `dist/` only. CSS repositories still need real manifest, CSS syntax, and path validation in `typecheck`.

## Manifest and compatibility

Themes use `schema: nstatus-extension-v1`, a stable ID, SemVer, and `type: theme`. `mode: css` uses one to four packaged `styles` and `base_theme: classic|cards`; `cards` is available only through a theme package. `mode: canvas` uses a packaged HTML `entry`, `permissions: ["status:read"]`, and an isolated message lifecycle. Canvas scripts cannot access the parent origin or arbitrary networks.

Declare HTTPS repository/homepage metadata, an SPDX-style license, an optional packaged preview, and preferably an exact `files` list. The platform records the uploaded ZIP SHA-256. Keep the package version synchronized with the source tag and generated artifact.

Prefer documented CSS variables and scope specific selectors under `body[data-extension-theme="ID"]`. Do not depend on deep `nth-child` selectors or temporary DOM details. A fork must use a new ID.

## Quality and acceptance

- Preserve status, errors, focus indicators, and all controls. Color cannot be the only status signal.
- Meet WCAG AA contrast and keyboard requirements; honor `prefers-reduced-motion`.
- Test at 320, 375, 768, 1280, and 1440 pixel widths on the declared CSS base or in the canvas layout.
- Test long provider names, tags, online/offline/delayed/unknown states, install, enable, disable, upgrade, delete, and built-in fallback.
- Publish source, license, changelog, reproducible build steps, tagged version, and ZIP SHA-256.

Use PATCH for compatible fixes, MINOR for compatible additions, and MAJOR for breaking changes. A release is accepted only when source commit, test result, manifest version, archive name, and checksum agree.

The project borrows independent repositories, explicit manifests/file lists, generated preference metadata, reproducible ZIPs, and checksum-bound distribution ideas from Komari and NodeGet. The runtime remains intentionally incompatible: executable layouts run only in the NStatus sandbox and communicate through its read-only message protocol.
