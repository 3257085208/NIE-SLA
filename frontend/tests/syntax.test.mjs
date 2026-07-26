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

const [appSource, adminSource, adminCss, adminHtml, indexHtml, apiProxySource, latencyAgentSource, latencyInstallerSource] = await Promise.all([
  readFile(path.join(root, 'app.js'), 'utf8'),
  readFile(path.join(root, 'js', 'admin.js'), 'utf8'),
  readFile(path.join(root, 'admin.css'), 'utf8'),
  readFile(path.join(root, 'admin.html'), 'utf8'),
  readFile(path.join(root, 'index.html'), 'utf8'),
  readFile(path.join(root, 'functions', 'api', '[[path]].js'), 'utf8'),
  readFile(path.join(root, 'latency-agent.py'), 'utf8'),
  readFile(path.join(root, 'install-latency.sh'), 'utf8'),
]);
const styleSource = await readFile(path.join(root, 'style.css'), 'utf8');
assert.match(adminSource, /showInstallProgress\(t\);[\s\S]*apiAdmin\(/, 'deploy must show feedback before requesting the command');
assert.match(adminSource, /data-retry-install/, 'deploy failures must offer a retry action');
assert.match(adminSource, /data-target-id=/, 'deploy buttons must carry a stable target id');
assert.match(adminSource, /button\?\.dataset\.targetId \|\| button\?\.closest\("tr"\)\?\.dataset\.id/, 'deploy actions must resolve the stable button target id first');
assert.match(adminSource, /targetGroupOptions\(type, target\.group_name\)/, 'target grouping must be a VPS/Web selector');
assert.match(adminSource, /<select id="mProvider">/, 'provider must use a single selector');
assert.match(adminSource, /id="mProviderCustom"/, 'provider selector must support a custom vendor');
assert.match(adminSource, /location_source/, 'target editor must show the Agent location source');
assert.doesNotMatch(adminSource, /id="mLocation"|id="mCity"|\/api\/catalog\/cities/, 'country and city must not be manually editable');
assert.match(adminSource, /到期时间（可选）/, 'target expiry must be clearly optional');
assert.match(adminSource, /formField\("机器类型"/, 'target editor must label line_type as machine type');
assert.doesNotMatch(adminSource, /formField\("线路类型"/, 'target editor must not expose the old line type label');
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
assert.match(adminHtml, /admin\.css\?v=20260726-action-layout1/, 'admin CSS cache key must publish the target action layout');
assert.match(adminHtml, /js\/admin\.js\?v=20260726-action-layout1/, 'admin JS cache key must publish the target action layout');
assert.match(adminSource, /target-action-main[\s\S]*targetActionsHtml\(target\)[\s\S]*betaTaskControlsHtml\(target\)/, 'standard target actions must render before Beta tasks');
assert.match(adminCss, /\.beta-task-actions\s*\{[\s\S]*border-top:/, 'Beta tasks must form a distinct action group');
assert.match(adminCss, /\.beta-task-meta\s*\{[\s\S]*flex-wrap:\s*wrap[\s\S]*justify-content:\s*flex-start/, 'Beta metadata must wrap without creating a detached right-aligned label');
assert.match(adminHtml, /settings-primary[\s\S]*settings-columns[\s\S]*settings-column/, 'settings must separate wide forms from independent card columns');
assert.match(adminCss, /\.settings-columns\s*\{[\s\S]*grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/, 'desktop settings cards must use three independent columns');
assert.match(adminCss, /@media \(max-width: 820px\) \{[\s\S]*\.settings-columns\s*\{\s*grid-template-columns:\s*1fr/, 'mobile settings cards must collapse to one column');
assert.match(adminHtml, /id="sAdminPath"/, 'admin settings must expose the custom entry path');
assert.match(adminHtml, /id="sAppUpdate"/, 'admin settings must expose the application update center');
assert.match(adminSource, /\/api\/system\/update\$\{refresh/, 'update center must check the Worker update API');
assert.doesNotMatch(adminSource, /appUpdateToken|github_token|appUpdateRepository/, 'update center must not collect repositories or GitHub credentials');
assert.match(adminSource, /function showAppUpdateChangelog\(\)[\s\S]*openModal\(\)/, 'changelog must open in the admin modal');
assert.match(adminSource, /function showAppUpdateGuide\(\)[\s\S]*NIE-SLA Online Update[\s\S]*Run workflow[\s\S]*openModal\(\)/, 'update guide must explain the no-input Actions workflow');
assert.doesNotMatch(adminSource, /data\.release_url[\s\S]*href=/, 'changelog must not link away to GitHub');
assert.match(adminSource, /每 \$\{escapeHtml\(data\.automatic_check_hours \|\| 6\)\} 小时自动检查/, 'update center must explain scheduled checks');
assert.match(adminSource, /infoRow\("版本", health\.version/, 'system information must display the Worker version');
assert.match(adminSource, /id="mTrafficResetDay"[\s\S]*min="1" max="31"/, 'target editor must expose an independent monthly traffic reset day');
assert.match(adminSource, /traffic_reset_day:\s*byId\("mType"\)/, 'target saves must persist the independent traffic reset day');
assert.match(adminSource, /流量重置日与 VPS 到期时间完全独立/, 'traffic settings must explain expiry/reset separation');
assert.match(adminSource, /修改流量重置日会立即切换当前统计周期/, 'changing the reset day must require an explicit warning');
assert.match(adminSource, /按已有的每日记录重新汇总/, 'reset-day warning must explain daily traffic recalculation');
assert.doesNotMatch(adminSource, /新的基线重新累计/, 'reset-day changes must not discard recorded daily traffic');
assert.doesNotMatch(adminSource, /流量会按到期日号|按照到期时间的日号每月重置/, 'traffic reset guidance must not depend on expiry');
assert.match(indexHtml, /app\.js\?v=20260725-daily-traffic1/, 'frontend cache key must publish daily traffic changes');
assert.doesNotMatch(appSource, /traffic\.reset === 'expiry-day'/, 'frontend traffic labels must not depend on expiry reset mode');
assert.match(adminSource, /JSON\.stringify\(\{ admin_path: value \}\)/, 'admin settings must persist the custom entry path');
assert.doesNotMatch(indexHtml, /data-frontend-theme|themeCanvas|themeBoot|theme-pending/, 'removed themes must not leave a startup shell');
assert.match(adminHtml, /id="sAppearance"/, 'admin must provide a centralized appearance editor');
assert.doesNotMatch(adminHtml, /id="pg-themes"|id="pg-plugins"|themeZip|pluginZip/, 'theme and plugin package UI must stay removed');
assert.match(adminSource, /appearanceSections/, 'admin must expose grouped frontend appearance fields');
assert.match(adminSource, /brand_home_url[\s\S]*header_right_image_width/, 'admin must expose brand and header media controls');
assert.match(adminSource, /show_header[\s\S]*show_chart[\s\S]*show_vps_details/, 'admin must expose frontend section visibility controls');
assert.match(appSource, /data\?\.frontend\?\.appearance/, 'frontend must consume public appearance settings');
assert.match(appSource, /--appearance-brand-logo-height/, 'frontend must apply the configured brand dimensions');
assert.match(adminSource, /JSON\.stringify\(\{ appearance \}\)/, 'admin must save frontend appearance settings');
assert.doesNotMatch(adminSource, /\/api\/(?:extensions|themes|plugins)|data-extension-action|x-extension-sha256/, 'admin must not retain extension package management');
assert.doesNotMatch(appSource, /js\/themes|frontendTheme|cardTheme/, 'frontend must not retain a theme runtime');
assert.doesNotMatch(apiProxySource, /x-extension-filename|x-extension-sha256/, 'Pages proxy must not retain extension upload headers');
assert.doesNotMatch(appSource, /meta-provider">🏪/, 'provider metadata must use typography instead of decorative emoji');
assert.doesNotMatch(appSource, /meta-line">🔀/, 'line type metadata must use typography instead of decorative emoji');
assert.doesNotMatch(appSource, /`📍 \$\{t\.location\}`/, 'fallback location metadata must not add decorative emoji');
assert.match(appSource, /apac:\s*'亚太'/, 'probe region labels must be fully Chinese');
assert.match(appSource, /wnam:\s*'北美西部'/, 'Western North America label must stay Chinese');
assert.doesNotMatch(appSource, /apac:\s*'APAC'/, 'probe region labels must not mix English abbreviations');
assert.doesNotMatch(appSource, /wnam:\s*'美国西部'/, 'region labels must use the shared Chinese wording');
assert.match(appSource, /function targetLocationLabel/, 'status page must format country + city labels');
assert.match(appSource, /s\.source === 'agent'[\s\S]*Agent 在线率/, 'Agent availability bars must distinguish heartbeat uptime from probe counts');
assert.doesNotMatch(appSource, /status_source === 'agent'[\s\S]{0,120}Cloudflare 探测记录/, 'Agent day bars must not be labelled as Cloudflare probe history');
assert.match(appSource, /vps-info-toggle/, 'mobile VPS details must be collapsible');
assert.match(appSource, /openNodeQualityReport/, 'frontend must open NodeQuality reports');
assert.match(appSource, /targetHasNodeQuality/, 'frontend must expose NQ only for targets with reports');
assert.match(appSource, /event\.target\.closest\('\.nq-close'\)\s*\|\|\s*event\.target\.classList\.contains\('nq-modal-backdrop'\)/, 'NQ tabs must not close the modal');
assert.match(styleSource, /\.nq-modal\s*\{[\s\S]*width:\s*min\(640px/, 'NQ modal should have a restrained desktop width');
assert.match(appSource, /service-title-line[\s\S]*nqButton/, 'classic VPS cards must place NQ beside the name');
assert.match(styleSource, /\.nq-image\s*\{[\s\S]*width:\s*min\(100%,\s*760px\)/, 'NQ images must use a readable content width');
assert.match(styleSource, /@media \(max-width: 760px\) \{[\s\S]*\.nq-image\s*\{\s*width:\s*100%/, 'NQ images must fill the available mobile content width');
assert.match(styleSource, /\.nq-ansi-panel\s*\{[\s\S]*-webkit-overflow-scrolling:\s*touch/, 'ANSI reports must support touch scrolling on iPhone');
assert.match(styleSource, /\.nq-panels\s*\{[\s\S]*flex:\s*1 1 auto[\s\S]*overscroll-behavior:\s*contain/, 'NQ report content must scroll without covering tabs');
assert.match(appSource, /panels\.scrollTop\s*=\s*0/, 'switching NQ tabs must reset vertical scroll');
assert.match(adminSource, /data-a="task-nq"/, 'admin must expose the fixed NodeQuality action');
assert.match(adminSource, /data-a="task-unlock"/, 'admin must expose the fixed IPv4 unlock action');
assert.match(adminSource, /\/api\/agent-tasks/, 'Beta actions must use the fixed task API');
assert.doesNotMatch(adminSource, /mNqReport|id="m(?:Command|Script|Args|Stdin)"|body:\s*JSON\.stringify\(\{[^}]*\b(?:command|script|args|stdin)\b/, 'admin must not accept reports or arbitrary command input');
assert.match(appSource, /Always keep explicit bounds/, 'chart zoom-out must keep explicit x bounds');
assert.match(adminHtml, /id="sGeoIp"/, 'settings must expose the GeoIP provider');
assert.match(adminHtml, /id="sBackup"/, 'settings must expose backup and restore');
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
