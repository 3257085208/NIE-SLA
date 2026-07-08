import { escapeAttr, escapeHtml } from '../shared/html.js';

const ASSET_ROOT = './assets/nodeget';

export function nodegetAvatarHtml() {
  return `<img src="${ASSET_ROOT}/logo.png" alt="" loading="lazy">`;
}

export function nodegetTopbarToolsHtml() {
  return `
    <button type="button" class="card-tool sort-tool" aria-label="Default sort">⇅ <span>默认</span></button>
    <span class="card-view-switch" aria-label="View mode">
      <button type="button" class="card-tool active">▦ <span>卡片</span></button>
      <button type="button" class="card-tool">☷ <span>表格</span></button>
      <button type="button" class="card-tool">◎ <span>地图</span></button>
    </span>
    <button type="button" class="card-tool moon-tool" aria-label="Theme">☾</button>
  `;
}

export function nodegetFlagHtml(code, extraClass = '') {
  const key = String(code || '').trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(key)) return '';
  const cls = ['region-flag', extraClass].filter(Boolean).join(' ');
  return `<img class="${escapeAttr(cls)}" src="https://flagcdn.com/${key.toLowerCase()}.svg" alt="${escapeAttr(key)}" title="${escapeAttr(key)}" loading="lazy">`;
}

export function nodegetOsLogoHtml(info = {}) {
  const key = distroKey(info);
  const label = key === 'windows' ? 'Windows' : key === 'linux' ? 'Linux' : key;
  return `<img src="${ASSET_ROOT}/linux-logo-icon/${escapeAttr(key)}.svg" alt="${escapeAttr(label)}" title="${escapeAttr(label)}" loading="lazy">`;
}

export function nodegetStatusDotClass(statusClass = '') {
  if (statusClass.includes('down')) return 'offline';
  if (statusClass.includes('degraded') || statusClass.includes('unknown')) return 'warning';
  return 'online';
}

export function nodegetCardMetaLine(parts = []) {
  return parts.filter(Boolean).map(escapeHtml).join(' · ');
}

function distroKey(info = {}) {
  const text = [info.os, info.platform, info.distro, info.kernel].filter(Boolean).join(' ').toLowerCase();
  if (text.includes('windows')) return 'windows';
  if (text.includes('debian')) return 'debian';
  if (text.includes('ubuntu')) return 'ubuntu';
  if (text.includes('alpine')) return 'alpinelinux-icon';
  if (text.includes('centos')) return 'centos';
  if (text.includes('fedora')) return 'fedora';
  if (text.includes('freebsd')) return 'freebsd';
  if (text.includes('arch')) return 'archlinux';
  if (text.includes('rocky')) return 'rocky';
  if (text.includes('red hat') || text.includes('redhat')) return 'redhat';
  if (text.includes('oracle')) return 'oracle';
  if (text.includes('kali')) return 'kali';
  if (text.includes('nixos')) return 'nixos';
  if (text.includes('manjaro')) return 'manjaro';
  if (text.includes('mint')) return 'mint';
  if (text.includes('zorin')) return 'zorin';
  if (text.includes('gentoo')) return 'gentoo';
  return 'linux';
}
