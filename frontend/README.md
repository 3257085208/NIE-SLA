# NStatus Frontend — Status Dashboard

The public-facing status page and admin panel, hosted on Cloudflare Pages.

## Features

- **Dual Theme**: Cards theme (NodeGet-style) and Classic theme (traditional list)
- **Responsive**: Mobile-polished layout adapts from desktop to phone
- **Charts**: Interactive time-series charts for latency, CPU, memory, disk, network, connections, disk I/O, and TCP ping
- **Filtering**: Text search across node names, IPs, domains, and groups
- **Admin Panel**: Full CRUD for targets, ping targets, alerts, and settings (served via Worker)
- **Agent Installers**: Self-contained install scripts served from Pages

## Quick Deploy

```bash
cd frontend

# Create config pointing to your Worker
echo 'window.NSTATUS_CONFIG = { apiBase: "https://your-worker.your-subdomain.workers.dev" };' > config.js

# Deploy
npx wrangler pages deploy ./ --project-name=nstatus
```

## Structure

```
frontend/
├── index.html           # Status page SPA
├── app.js               # Main dashboard logic (2737 lines)
├── config.js            # Runtime API base URL configuration
├── style.css            # Stylesheet (cards + classic themes)
├── 404.html             # Custom 404
├── _redirects            # Pages routing rules
├── functions/           # Pages Functions (API proxy)
│   ├── api/[[path]].js  # Proxies /api/* → Worker
│   └── admin/[[path]].js # Proxies /admin/* → Worker
├── js/
│   ├── shared/          # Billing, format, HTML, traffic utilities
│   ├── themes/          # Card and detail theme modules
│   └── install-command.js  # Clipboard utility
├── assets/              # Static assets (logos, flags, OS icons)
├── bin/
│   └── SHA256SUMS       # Agent binary checksum manifest
├── install.sh           # Linux installer entry
├── install.ps1          # Windows PowerShell installer
├── setup.sh             # Interactive Linux setup
├── quick-install.sh     # Non-interactive installer
├── update.sh            # Agent update script
└── cftz                 # Agent management CLI
```

## Configuration

### `config.js`

The frontend reads its API URL from `config.js` at runtime:

```js
window.NSTATUS_CONFIG = {
  apiBase: "https://your-worker.your-subdomain.workers.dev"
};
```

This can also be set via:
- URL query: `?api=https://your-worker.your-subdomain.workers.dev`
- LocalStorage: `localStorage.setItem('nstatus.apiBase', '...')`

### Pages Functions

The `functions/api/[[path]].js` and `functions/admin/[[path]].js` files proxy requests from Pages to the Worker. This is needed because the status page and the Worker API may be on different domains.

Configure the proxied Worker URL in Pages environment variables:
- Set `NSTATUS_API_BASE` in your Pages project dashboard

## Themes

### Cards Theme (Default)

NodeGet-inspired card layout with:
- VPS resource rings (CPU, memory, disk)
- Region flags and OS logos
- Traffic progress bars
- Expandable detail views with full time-series charts

### Classic Theme

Traditional list-based layout with:
- Grouped service cards
- Uptime strips
- Inline latency charts

Users can switch themes via the topbar toggle (preference saved to localStorage).

## Agent Installer Files

The frontend directory also serves as the distribution point for agent installers. These files are designed to be downloaded directly by VPS operators:

| File | Purpose |
|---|---|
| `install.sh` | POSIX sh entry — downloads `setup.sh` and passes env vars |
| `setup.sh` | Full interactive/non-interactive installer |
| `quick-install.sh` | One-liner wrapper for env-based install |
| `update.sh` | In-place agent binary update |
| `install.ps1` | Windows PowerShell installer |
| `cftz` | Agent management CLI |
| `bin/SHA256SUMS` | Binary integrity manifest |

All installers verify binary SHA-256 checksums against the manifest before installation. The manifest hash is pinned to prevent tampering.

## Development

The frontend is vanilla JavaScript — no build step required. Edit files directly and deploy.

### Testing

Tests are in the root `test.sh` — the frontend checks verify:
- `app.js` and `config.js` syntax
- Shared module imports resolve correctly
- Theme modules load without errors

## Browser Support

- Chrome/Edge 90+
- Firefox 90+
- Safari 15+
- Mobile browsers supported
