# Third-party theme development

The admin "Themes" page accepts ZIPs conforming to `nie-sla-theme-v1`. Uploads and overwrites stay inactive until an admin enables them; at most one theme is enabled at a time, and disabling restores the original UI immediately.

## Theme types

CSS themes keep the original HTML, data, and interactions and only restyle the public status page. No JavaScript runs. Scope selectors with the theme ID:

```css
body[data-extension-theme="example-clean"] .system-banner {
  border-radius: 0;
}
```

CSS can read data already shown on the public page, so install only trusted sources. Themes never apply to the admin panel.

Canvas themes can replace the entire public layout. The entry HTML runs in an iframe with `sandbox="allow-scripts"` and no `allow-same-origin`, plus a dedicated CSP: no access to the parent DOM, cookies, local storage, or admin session; no forms, popups, object loading, or direct network access; data arrives only through the message protocol; and only the `status:read` permission may be declared. All HTML, CSS, JavaScript, fonts, and images must be inside the ZIP.

## ZIP structure and limits

`manifest.json` must sit at the ZIP root:

```text
my-theme.zip
|-- manifest.json
|-- theme.css
|-- index.html
|-- theme.js
`-- assets/logo.webp
```

The Worker enforces:

- ZIP up to 8 MB; 16 MB unpacked.
- Up to 300 files; 4 MB per file.
- `manifest.json` up to 64 KiB.
- Paths must be NFC Unicode, at most 8 levels; absolute paths, backslashes, empty segments, `.`, `..`, control characters, and duplicate paths are rejected.
- Allowed types: `.css`, `.html`, `.js`, `.json`, common web images, WOFF/WOFF2 fonts.
- The browser computes SHA-256 and the Worker recomputes and compares it.

## Manifest

CSS theme example:

```json
{
  "schema": "nie-sla-theme-v1",
  "id": "example-clean",
  "name": "Example Clean",
  "version": "1.0.0",
  "type": "theme",
  "mode": "css",
  "styles": ["theme.css"],
  "author": "Example Author",
  "description": "A minimal CSS theme.",
  "license": "MIT",
  "files": ["manifest.json", "theme.css"]
}
```

Canvas themes switch `mode` to `canvas` and add:

```json
{
  "entry": "index.html",
  "permissions": ["status:read"],
  "height": 1000
}
```

Field rules:

| Field | Rule |
| --- | --- |
| `schema` | fixed `nie-sla-theme-v1` |
| `id` | 3-49 lowercase letters, digits, or hyphens, starting with a letter; stable once published |
| `name` | 1-64 characters |
| `version` | SemVer, e.g. `1.2.0` or `1.2.0-beta.1` |
| `type` | fixed `theme` |
| `mode` | `css` or `canvas` |
| `styles` | required for CSS mode; 1-4 in-package CSS files |
| `entry` | required for canvas mode; in-package HTML |
| `permissions` | canvas only; must be exactly `["status:read"]` |
| `height` | canvas initial height, 400-12000 px; can be updated at runtime |
| `files` | recommended; must match the ZIP exactly, including `manifest.json` |
| `preview` | optional in-package image |
| `repository` / `homepage` | optional; HTTPS URLs without credentials |
| `license` | optional SPDX-style identifier |

## Canvas message protocol

The theme announces readiness:

```js
parent.postMessage({ type: "nie-sla:ready" }, "*");
```

The parent pushes the latest public state:

```js
{
  type: "nie-sla:status",
  api_version: "v1",
  payload: { /* desensitized /api/status payload */ }
}
```

To request other read-only data:

```js
parent.postMessage({
  type: "nie-sla:request",
  request_id: "metrics-1",
  resource: "metrics",
  query: { agent_id: "target-id", hours: 24 }
}, "*");
```

Allowed `resource` values: `status`, `checks`, `metrics`, `pings`, `latency`. The response:

```js
{
  type: "nie-sla:response",
  api_version: "v1",
  request_id: "metrics-1",
  ok: true,
  payload: {}
}
```

Failures return `ok: false` with a short error. After content changes, request a height update:

```js
parent.postMessage({ type: "nie-sla:resize", height: document.documentElement.scrollHeight }, "*");
```

Message receivers must validate `event.data`, the message type, and field types, and never inject public data via `innerHTML`.

## Release checklist

1. Test at 390 px phone, tablet, and desktop widths with no horizontal overflow.
2. Keep clear online/failure/unknown/packet-loss states; do not rely on color alone.
3. Support keyboard operation, visible focus, semantic headings, and `prefers-reduced-motion`.
4. Do not impersonate official themes; state the author, version, license, and source.
5. Build the ZIP from a clean directory and publish its SHA-256: `shasum -a 256 theme.zip`.
6. Keep `id` stable and raise SemVer on updates; re-enable after overwrite upload.

Runnable examples live in `examples/themes/minimal-css/` and `examples/themes/minimal-canvas/`.

## Backup and migration

Theme registrations live in D1; extracted ZIP files live in R2. Portable JSON backups do not include R2 files. When migrating, reuse or copy the original R2; otherwise re-upload the theme ZIPs in the new environment.
