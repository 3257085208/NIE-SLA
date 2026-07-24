import { escapeAttr, escapeHtml } from '../shared/html.js';
import { countryFlagAsset } from '../shared/target-catalogs.js';

export function cardThemeAvatarHtml() {
  return '<span class="brand-avatar-mark" aria-hidden="true">NIE</span>';
}

export function cardThemeTopbarToolsHtml() {
  return `
    <button type="button" class="card-tool sort-tool" aria-label="默认排序">⇅ <span>默认</span></button>
    <span class="card-view-switch" aria-label="视图模式">
      <button type="button" class="card-tool active">▦ <span>卡片</span></button>
      <button type="button" class="card-tool">☷ <span>表格</span></button>
      <button type="button" class="card-tool">◎ <span>地图</span></button>
    </span>
    <button type="button" class="card-tool moon-tool" aria-label="主题">☾</button>
  `;
}

export function cardThemeFlagHtml(code, extraClass = '') {
  const key = String(code || '').trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(key)) return '';
  const cls = ['region-flag', extraClass].filter(Boolean).join(' ');
  return `<img class="${escapeAttr(cls)}" src="${escapeAttr(countryFlagAsset(key))}" alt="${escapeAttr(key)}" title="${escapeAttr(key)}" width="18" height="13" loading="lazy">`;
}

export function cardThemeOsBadgeHtml(info = {}) {
  const key = distroKey(info);
  const label = key === 'windows' ? 'Windows' : key === 'linux' ? 'Linux' : key;
  return `<span class="os-badge-text" title="${escapeAttr(label)}">${escapeHtml(distroAbbreviation(label))}</span>`;
}

export function cardThemeStatusDotClass(statusClass = '') {
  if (statusClass.includes('down')) return 'offline';
  if (statusClass.includes('degraded') || statusClass.includes('unknown')) return 'warning';
  return 'online';
}

export function cardThemeMetaLine(parts = []) {
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

function distroAbbreviation(label) {
  const normalized = String(label || '').trim();
  if (!normalized) return 'OS';
  if (normalized.toLowerCase() === 'windows') return 'WIN';
  return normalized.slice(0, 3).toUpperCase();
}
