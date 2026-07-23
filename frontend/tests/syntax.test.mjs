import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const files = [path.join(root, 'app.js'), path.join(root, 'config.js')];

for (const directory of ['functions', 'js']) {
  files.push(...await javascriptFiles(path.join(root, directory)));
}

for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  assert.equal(result.status, 0, `${path.relative(root, file)} syntax failed:\n${result.stderr}`);
}

const [appSource, adminSource, adminCss, adminHtml, latencyAgentSource, latencyInstallerSource] = await Promise.all([
  readFile(path.join(root, 'app.js'), 'utf8'),
  readFile(path.join(root, 'js', 'admin.js'), 'utf8'),
  readFile(path.join(root, 'admin.css'), 'utf8'),
  readFile(path.join(root, 'admin.html'), 'utf8'),
  readFile(path.join(root, 'latency-agent.py'), 'utf8'),
  readFile(path.join(root, 'install-latency.sh'), 'utf8'),
]);
const styleSource = await readFile(path.join(root, 'style.css'), 'utf8');
assert.match(adminSource, /showInstallProgress\(t\);[\s\S]*apiAdmin\(/, 'deploy must show feedback before requesting the command');
assert.match(adminSource, /data-retry-install/, 'deploy failures must offer a retry action');
assert.match(adminSource, /data-target-id=/, 'deploy buttons must carry a stable target id');
assert.match(adminSource, /button\?\.dataset\.targetId \|\| button\?\.closest\("tr"\)\?\.dataset\.id/, 'deploy actions must resolve the stable button target id first');
assert.match(adminSource, /targetGroupOptions\(type, target\.group_name\)/, 'target grouping must be a VPS/Web selector');
assert.match(adminSource, /bindCatalogSearch\("mLocationSearch", "mLocation"/, 'location must provide catalog search');
assert.match(adminSource, /currencyOptionsHtml\(target\.currency \|\| "USD"\)/, 'currency must use the supported selector');
assert.match(adminSource, /id="mNoPublicIp"/, 'VPS editor must expose the no-public-IP option');
assert.match(adminSource, /const cfDetails = noPublicIp[\s\S]*\? ""/, 'no-public-IP targets must hide Cloudflare status in admin');
assert.match(adminSource, /\/api\/latency-agents/, 'admin must manage independent Latency nodes');
assert.match(adminSource, /install-command\?node_id=/, 'Latency nodes must have an independent installer command');
assert.doesNotMatch(appSource, /pingRows \|\| cardLatencyRow/, 'Latency rendering must not fall back to Ping rows');
assert.doesNotMatch(adminCss, /min-width:\s*(?:1080|1280)px/, 'probe table must not regress to the old extra-wide layout');
assert.match(adminCss, /width:\s*min\(980px,\s*calc\(100vw - 44px\)\)/, 'admin content width should match the frontend rhythm');
assert.doesNotMatch(adminCss, /\.stat(?:\.\w+)?::before/, 'dashboard stats must not render decorative edge stripes');
assert.match(adminCss, /\.group-by-menu\s*\{[\s\S]*box-shadow:/, 'group selector must use the custom admin menu');
assert.match(adminSource, /data-group-value/, 'group selector must use structured custom options');
assert.match(adminCss, /\.modal::\-webkit-scrollbar\s*\{[\s\S]*display:\s*none/, 'long edit dialogs must hide the native scrollbar');
assert.match(adminCss, /#tTable \.table-scroll\s*\{\s*overflow:\s*visible/, 'only the card-based target table may overflow on mobile');
assert.match(adminHtml, /admin\.css\?v=20260723-city-mobile-chart/, 'admin CSS cache key must publish city/mobile/chart fixes');
assert.match(adminHtml, /js\/admin\.js\?v=20260723-city-mobile-chart/, 'admin JS cache key must publish city/mobile/chart fixes');
assert.match(adminHtml, /id="pg-themes"[\s\S]*id="themeZip"[\s\S]*id="themeTable"/, 'admin must provide an independent theme page and upload path');
assert.match(adminHtml, /id="pg-plugins"[\s\S]*id="pluginZip"[\s\S]*id="pluginTable"/, 'admin must provide an independent plugin page and upload path');
assert.match(adminSource, /"\/api\/themes"/, 'admin must use the dedicated theme API');
assert.match(adminSource, /"\/api\/plugins"/, 'admin must use the dedicated plugin API');
assert.doesNotMatch(adminSource, /\/api\/extensions\/(?:manage|upload)/, 'admin must not use the legacy combined management API');
assert.match(adminSource, /data-extension-action/, 'admin must manage installed extensions');
assert.match(appSource, /initializeFrontendExtensions\(\)/, 'frontend must initialize enabled extensions');
assert.doesNotMatch(appSource, /meta-provider">🏪/, 'provider metadata must use typography instead of decorative emoji');
assert.doesNotMatch(appSource, /meta-line">🔀/, 'line type metadata must use typography instead of decorative emoji');
assert.doesNotMatch(appSource, /`📍 \$\{t\.location\}`/, 'fallback location metadata must not add decorative emoji');
assert.match(appSource, /apac:\s*'亚太'/, 'probe region labels must be fully Chinese');
assert.match(appSource, /wnam:\s*'北美西部'/, 'Western North America label must stay Chinese');
assert.doesNotMatch(appSource, /apac:\s*'APAC'/, 'probe region labels must not mix English abbreviations');
assert.doesNotMatch(appSource, /wnam:\s*'美国西部'/, 'region labels must use the shared Chinese wording');
assert.match(appSource, /function targetLocationLabel/, 'status page must format country + city labels');
assert.match(appSource, /vps-info-toggle/, 'mobile VPS details must be collapsible');
assert.match(appSource, /openNodeQualityReport/, 'frontend must open NodeQuality reports');
assert.match(appSource, /targetHasNodeQuality/, 'frontend must expose NQ only for targets with reports');
assert.match(appSource, /event\.target\.closest\('\.nq-close'\)\s*\|\|\s*event\.target\.classList\.contains\('nq-modal-backdrop'\)/, 'NQ tabs must not close the modal');
assert.match(styleSource, /\.nq-modal\s*\{[\s\S]*width:\s*min\(920px/, 'NQ modal should have a restrained desktop width');
assert.match(adminSource, /mNqReport/, 'admin target editor must accept NodeQuality reports');
assert.match(appSource, /Always keep explicit bounds/, 'chart zoom-out must keep explicit x bounds');
assert.match(adminSource, /id="mCity"/, 'admin target editor must accept a city field');
assert.match(adminSource, /city:\s*\(byId\("mCity"\)/, 'admin save payload must include city');
assert.match(latencyAgentSource, /"User-Agent": USER_AGENT/, 'Latency agent must avoid Cloudflare rejecting Python urllib requests');
assert.match(latencyAgentSource, /sys\.argv\[1:\] == \["--once"\]/, 'Latency agent must support an installation preflight cycle');
assert.match(latencyAgentSource, /def update_if_needed\(\):/, 'Latency agent must support automatic updates');
assert.match(latencyAgentSource, /\/api\/latency-agent\/update-policy\?node_id=/, 'Latency agent must read the server-side update policy');
assert.match(latencyAgentSource, /policy\.get\("script_version", SCRIPT_VERSION\)/, 'Latency updates must use the server-selected cache version');
assert.match(latencyAgentSource, /os\.replace\(next_path, SCRIPT_PATH\)/, 'Latency agent updates must replace the script atomically');
assert.match(latencyInstallerSource, /latency-agent\.py --once/, 'Latency installer must verify API access before reporting success');
assert.match(latencyInstallerSource, /latency-agent\.py\?v=4/, 'Latency installer must cache-bust the current agent script');
assert.match(latencyInstallerSource, /stop_existing_latency_agent\(\)/, 'Latency reinstall must stop all existing agent processes');
assert.match(latencyInstallerSource, /systemctl disable --now nstatus-latency-agent\.service/, 'Latency reinstall must stop and disable the old service');
assert.match(latencyInstallerSource, /pgrep -f '\/opt\/nstatus-latency\/latency-agent\.py'/, 'Latency reinstall must find residual agent processes');
assert.match(latencyInstallerSource, /ReadWritePaths=\/opt\/nstatus-latency/, 'Latency service must allow atomic self-updates inside its sandbox');
assert.match(latencyInstallerSource, /systemctl is-active --quiet nstatus-latency-agent\.service/, 'Latency installer must verify the service is running');

console.log(`frontend syntax tests passed (${files.length} files)`);

async function javascriptFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await javascriptFiles(absolute));
    else if (entry.isFile() && entry.name.endsWith('.js')) files.push(absolute);
  }
  return files;
}
