# 14 Theme Engineering Standard

This document defines the source-to-ZIP contract for third-party NStatus themes. Read [13 Extensions and Developer API](13-extensions-developer-guide.md) for the platform package and API contract.

## Repository contract

Maintain each theme in an independent repository with `src/`, `tests/`, `manifest.json`, `README.md`, `LICENSE`, `CHANGELOG.md`, and a generated `dist/` directory. Only `dist/` may be packaged; `dist/manifest.json` must be at the ZIP root. Never ship source caches, credentials, `.env`, private infrastructure, or `node_modules`.

Required equivalent commands are `npm run dev`, `npm run build`, `npm run typecheck`, `npm test`, and `npm run package`. `build` must recreate `dist/`; `package` must create `release/<id>-<version>.zip` from `dist/` only. CSS-only repositories still need real manifest, CSS syntax, and path validation in `typecheck`.

## Manifest and compatibility

Themes use `schema: nstatus-extension-v1`, stable ID, SemVer version, `type: theme`, `base_theme: classic|cards`, and one to four packaged CSS paths in `styles`. Version 1 never executes theme JavaScript and cannot load remote CSS, fonts, or runtime network resources.

Prefer documented CSS variables and scope specific selectors under `body[data-extension-theme="ID"]`. Do not depend on deep `nth-child` selectors or temporary DOM details. A fork must use a new ID.

## Quality and acceptance

- Preserve status, errors, focus indicators, and all controls. Color cannot be the only status signal.
- Meet WCAG AA contrast and keyboard requirements; honor `prefers-reduced-motion`.
- Test at 320, 375, 768, 1280, and 1440 pixel widths on both built-in base layouts.
- Test long provider names, tags, online/offline/delayed/unknown states, install, enable, disable, upgrade, delete, and built-in fallback.
- Publish source, license, changelog, reproducible build steps, tagged version, and ZIP SHA-256.

Use PATCH for compatible fixes, MINOR for compatible additions, and MAJOR for breaking changes. A release is accepted only when source commit, test result, manifest version, archive name, and checksum agree.

The project borrows NodeGet's independent-theme, explicit-manifest, standard-command, and fixed-output organization. The runtime is intentionally incompatible: NStatus v1 themes are CSS-only and must pass this security, accessibility, and fallback contract.
