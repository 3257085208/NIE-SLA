# 13 Extensions and Developer API

NStatus accepts validated ZIP packages from the separate Admin -> Themes and Admin -> Plugins pages. Version 1 supports CSS themes, sandboxed full-layout canvas themes, sandboxed read-only plugin panels, and a stable public API.

Use an independent repository per theme or plugin. See [14 Theme Engineering Standard](14-theme-development-standard.md) and [15 Plugin Engineering Standard](15-plugin-development-standard.md) for required layout, commands, testing, SemVer, licensing, and release acceptance. The structure borrows useful independent-package ideas from NodeGet, but NStatus has an incompatible least-privilege runtime.

## Package Layout

`manifest.json` must be at the ZIP root. Packages are limited to 8 MB compressed, 16 MB expanded, 300 files, and 4 MB per file. Absolute paths, `..`, backslash paths, and unsupported file extensions are rejected.

```text
manifest.json
theme.css
assets/logo.webp
```

The common manifest fields are:

```json
{
  "schema": "nstatus-extension-v1",
  "id": "example-extension",
  "name": "Example Extension",
  "version": "1.0.0",
  "type": "theme",
  "author": "Developer",
  "description": "Short description"
}
```

IDs match `[a-z][a-z0-9-]{2,48}` and versions use SemVer. Optional normalized metadata includes HTTPS `repository`/`homepage`, SPDX-style `license`, packaged `preview`, and an exact `files` list. The list may include or omit the root `manifest.json`; all other entries must match the ZIP exactly. The Worker calculates and records the ZIP SHA-256. Uploading the same ID replaces its files and preserves its enabled state.

## Themes

CSS themes use `mode: css`, declare `base_theme` (`classic` or the package-only `cards` layout), and provide one to four CSS files in `styles`. The only built-in fallback is `classic`. Prefer stable root variables and scope rules with `body[data-extension-theme="ID"]`.

Canvas themes use `mode: canvas`, a packaged HTML `entry`, `permissions: ["status:read"]`, and a height from 400 to 12000. They can implement an entire frontend with any build tool, but run in `sandbox="allow-scripts"` without same-origin access or direct networking. They receive `nstatus:status` and may request only `status`, `checks`, `metrics`, `pings`, or `latency` through `nstatus:request`; the parent maps those requests to credential-free `/api/v1/*` calls.

Only one third-party theme can be active. Disabling it returns the site to `classic`. See `examples/extensions/theme-minimal/`, `theme-cards/`, and `theme-canvas/`.

## Plugins

Plugins declare an HTML `entry`, `permissions: ["status:read"]`, and a height from 200 to 1200. They run in `sandbox="allow-scripts"` without same-origin access. The plugin CSP blocks network access, forms, inline scripts, and top-level navigation; all assets must be packaged.

```js
window.addEventListener('message', event => {
  if (event.source !== parent || event.data?.type !== 'nstatus:status') return;
  const status = event.data.payload;
});
parent.postMessage({ type: 'nstatus:ready' }, '*');
```

Plugins may request a bounded resize with `{ type: "nstatus:resize", height: 480 }`. See `examples/extensions/plugin-status-summary/`.

## Versioned API

`GET /api/v1` returns the capability manifest. Stable read-only aliases are `/api/v1/status`, `/api/v1/checks`, `/api/v1/metrics`, `/api/v1/pings`, and `/api/v1/latency`. Responses include `X-NStatus-API-Version: v1`.

Browser-based alternate frontends need an exact HTTPS origin in `DEVELOPER_API_ORIGINS`; wildcard CORS is rejected and HTTP is accepted only for localhost. This setting never opens Admin or Agent writes.

## Security and Publishing

New uploads are disabled by default. Administrators should review source, license, checksums, and changes before enabling a package. The package model borrows reproducible static builds, explicit file lists, generated settings metadata, and checksum-bound distribution ideas from Komari and NodeGet while retaining NStatus sandboxing. Packages must not contain credentials, private infrastructure, production data, or build caches.
