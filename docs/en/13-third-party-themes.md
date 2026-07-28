# Third-Party Theme Specification

NIE-SLA supports theme packages only. It does not expose plugins, admin scripts, or an arbitrary extension runtime. Upload a ZIP from **Admin -> Themes**. Every new or replacement upload is disabled until an administrator reviews its source and SHA-256. Only one theme can be active; disabling it restores the built-in frontend.

## Theme modes

### CSS

A CSS theme keeps the built-in HTML, data flow, and interactions and only changes public-page styling. JavaScript is not executed. Scope rules to the stable theme attribute:

```css
body[data-extension-theme="example-clean"] .system-banner {
  border-radius: 0;
}
```

CSS applies only to the public status page, never the admin panel.

### Canvas

A Canvas theme owns the complete public layout. Its entry document runs in an iframe with `sandbox="allow-scripts"`, without `allow-same-origin`, and with a restrictive CSP. It cannot access the parent DOM, cookies, storage, admin sessions, forms, child windows, or the network. It may declare only `status:read` and receive redacted public data through `postMessage`.

All HTML, CSS, JavaScript, fonts, and images must be included in the ZIP.

## ZIP and manifest

Place `manifest.json` at the ZIP root. Limits are 8 MB compressed, 16 MB expanded, 300 files, 4 MB per file, a 64 KiB manifest, and eight path levels. Absolute paths, backslashes, traversal segments, control characters, non-NFC names, duplicate paths, and unsupported extensions are rejected. The browser supplies a SHA-256 digest and the Worker recomputes it before storage.

CSS manifest:

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

Canvas themes use `"mode": "canvas"` and add:

```json
{
  "entry": "index.html",
  "permissions": ["status:read"],
  "height": 1000
}
```

`id` must start with a lowercase letter and contain 3-49 lowercase letters, digits, or hyphens. Keep it stable across releases. `version` uses SemVer. CSS themes declare one to four package-local stylesheets. Canvas themes declare one package-local HTML entry and exactly the `status:read` permission. The optional `files` array must exactly match the archive, including `manifest.json`. Repository and homepage URLs must be credential-free HTTPS URLs; licenses should use SPDX identifiers.

## Canvas protocol

Signal readiness:

```js
parent.postMessage({ type: "nie-sla:ready" }, "*");
```

The parent publishes `{ type: "nie-sla:status", api_version: "v1", payload }`. A theme may request only `status`, `checks`, `metrics`, `pings`, or `latency`:

```js
parent.postMessage({
  type: "nie-sla:request",
  request_id: "metrics-1",
  resource: "metrics",
  query: { agent_id: "target-id", hours: 24 }
}, "*");
```

Responses use `nie-sla:response`, repeat `request_id`, and contain either `{ ok: true, payload }` or `{ ok: false, error }`. Resize the isolated canvas with:

```js
parent.postMessage({ type: "nie-sla:resize", height: document.documentElement.scrollHeight }, "*");
```

Validate all received message fields and render untrusted values with DOM text APIs rather than `innerHTML`.

## Release checklist

- Test 390 px mobile, tablet, and desktop layouts without page-level horizontal overflow.
- Preserve distinct online, failed, unknown, and packet-loss states; do not rely on color alone.
- Support keyboard navigation, visible focus, semantic headings, and reduced motion.
- Publish author, SemVer, license, source URL, and `shasum -a 256 theme.zip` output.
- Keep the theme ID stable and increment the version. Replacement uploads require fresh administrator approval.

Runnable sources are in `examples/themes/minimal-css/` and `examples/themes/minimal-canvas/`.

## Backup and migration

Theme registry data lives in D1 and extracted package files live in R2. Portable JSON backups do not contain R2 objects. Reuse or copy the original R2 binding during migration, or upload the ZIP again in the new deployment.
