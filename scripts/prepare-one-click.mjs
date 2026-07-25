import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const frontendRoot = path.join(root, 'frontend');
const outputRoot = path.join(root, 'dist-one-click');
const repository = '3257085208/NIE-SLA';
const excluded = new Set(['.git', '.wrangler', 'README.md', '_redirects', 'functions', 'node_modules', 'package.json', 'tests', 'bin']);

await assertDirectory(frontendRoot);
await rm(outputRoot, { recursive: true, force: true });
await cp(frontendRoot, outputRoot, {
  recursive: true,
  filter: (entry) => !path.relative(frontendRoot, entry).split(path.sep).some((part) => excluded.has(part)),
});
await prepareAgentRelease(path.join(outputRoot, 'bin'));
console.log(`One-click assets prepared in ${path.relative(root, outputRoot)}`);

async function prepareAgentRelease(binRoot) {
  const requestedTag = String(process.env.NSTATUS_AGENT_RELEASE_TAG || '').trim();
  const endpoint = requestedTag
    ? `https://api.github.com/repos/${repository}/releases/tags/${encodeURIComponent(requestedTag)}`
    : `https://api.github.com/repos/${repository}/releases/latest`;
  const release = await fetchJson(endpoint);
  const assets = new Map((release.assets || []).map((asset) => [String(asset.name), String(asset.browser_download_url)]));
  const version = await downloadText(requiredAsset(assets, 'VERSION'));
  const manifest = await downloadText(requiredAsset(assets, 'SHA256SUMS'));
  const normalizedVersion = version.trim();
  if (!/^v\d+\.\d+\.\d+$/.test(normalizedVersion) || normalizedVersion !== release.tag_name) {
    throw new Error(`Release VERSION mismatch: ${normalizedVersion || '(empty)'} / ${release.tag_name || '(missing tag)'}`);
  }

  const files = parseManifest(manifest);
  for (const required of ['nstatus-metrics-linux-amd64', 'nstatus-metrics-linux-arm64', 'nstatus-metrics-windows-amd64.exe']) {
    if (!files.has(required)) throw new Error(`Release manifest is missing ${required}`);
  }

  await mkdir(binRoot, { recursive: true });
  await writeFile(path.join(binRoot, 'VERSION'), `${normalizedVersion}\n`);
  await writeFile(path.join(binRoot, 'SHA256SUMS'), manifest);
  for (const [name, expectedHash] of files) {
    const bytes = await downloadBytes(requiredAsset(assets, name));
    const actualHash = createHash('sha256').update(bytes).digest('hex');
    if (actualHash !== expectedHash) throw new Error(`SHA-256 mismatch for ${name}`);
    await writeFile(path.join(binRoot, name), bytes, { mode: name.endsWith('.exe') ? 0o644 : 0o755 });
  }
}

function parseManifest(source) {
  const files = new Map();
  for (const line of String(source || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    const match = line.match(/^([a-f0-9]{64})\s+\*?(nstatus-metrics-[A-Za-z0-9._-]+)$/i);
    if (!match || path.basename(match[2]) !== match[2]) throw new Error(`Invalid SHA256SUMS line: ${line}`);
    files.set(match[2], match[1].toLowerCase());
  }
  if (!files.size) throw new Error('Release manifest contains no Agent binaries');
  return files;
}

function requiredAsset(assets, name) {
  const url = assets.get(name);
  if (!url) throw new Error(`Release asset is missing: ${name}`);
  return url;
}

async function fetchJson(url) {
  const response = await fetchWithRetry(url, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'NIE-SLA-One-Click/1.0' } });
  if (!response.ok) throw new Error(`GitHub release lookup failed: HTTP ${response.status}`);
  return response.json();
}

async function downloadText(url) {
  return new TextDecoder().decode(await downloadBytes(url, 1_000_000));
}

async function downloadBytes(url, maxBytes = 32 * 1024 * 1024) {
  const response = await fetchWithRetry(url, { redirect: 'follow', headers: { 'user-agent': 'NIE-SLA-One-Click/1.0' } });
  if (!response.ok) throw new Error(`Release download failed: HTTP ${response.status}`);
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > maxBytes) throw new Error(`Release asset exceeds ${maxBytes} bytes`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!bytes.length || bytes.length > maxBytes) throw new Error(`Release asset has invalid size: ${bytes.length}`);
  return bytes;
}

async function fetchWithRetry(url, options, maxAttempts = 5) {
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetch(url, options);
      if (response.ok || !isRetryableStatus(response.status) || attempt === maxAttempts) return response;
      await response.body?.cancel().catch(() => {});
    } catch (error) {
      lastError = error;
      if (attempt === maxAttempts) throw error;
    }
    await new Promise(resolve => setTimeout(resolve, 500 * (2 ** (attempt - 1))));
  }
  throw lastError || new Error('release request failed');
}

function isRetryableStatus(status) {
  return status === 408 || status === 429 || status >= 500;
}

async function assertDirectory(directory) {
  const info = await stat(directory).catch(() => null);
  if (!info?.isDirectory()) throw new Error(`Missing directory: ${directory}`);
}
