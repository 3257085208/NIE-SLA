/** Multi-dimension VPS / target grouping helpers. */

export const GROUP_BY_OPTIONS = [
  { id: 'group', label: 'VPS / Web' },
  { id: 'provider', label: '商家' },
  { id: 'location', label: '国家/地区' },
  { id: 'price', label: '价格档' },
  { id: 'line_type', label: '机器类型' },
];

export const LINE_TYPE_OPTIONS = [
  { id: '', label: '未设置' },
  { id: '建站机', label: '建站机' },
  { id: '线路机', label: '线路机' },
  { id: '落地机', label: '落地机' },
  { id: '中转机', label: '中转机' },
  { id: '家宽机', label: '家宽机' },
  { id: '解锁机', label: '解锁机' },
  { id: '存储机', label: '存储机' },
  { id: '备份机', label: '备份机' },
  { id: '算力机', label: '算力机' },
  { id: '游戏机', label: '游戏机' },
  { id: '邮件机', label: '邮件机' },
  { id: '综合用途', label: '综合用途' },
  { id: '其他', label: '其他' },
];

const LEGACY_LINE_TYPES = new Set(['线路鸡', '落地鸡', '中转', '入口', '家宽']);

export function displayGroupName(name) {
  const value = String(name || '').trim();
  if (!value) return '未分组';
  if (/^default$/i.test(value)) return '默认分组';
  if (/^nodes?$/i.test(value)) return '节点';
  return value;
}

export function priceBandKey(target = {}) {
  const amount = Number(target.price_cny ?? target.price);
  if (!Number.isFinite(amount) || amount < 0) return '未设置价格';
  if (amount === 0) return '免费 / 0';
  if (amount < 5) return '< 5';
  if (amount < 10) return '5 – 10';
  if (amount < 20) return '10 – 20';
  if (amount < 50) return '20 – 50';
  if (amount < 100) return '50 – 100';
  return '≥ 100';
}

export function groupKeyFor(target = {}, mode = 'group') {
  switch (String(mode || 'group')) {
    case 'provider':
      return displayGroupName(target.provider || '未设置商家');
    case 'location':
      return displayGroupName(target.location || '未设置地区');
    case 'price':
      return priceBandKey(target);
    case 'line_type':
      return displayGroupName(target.line_type || '未设置机器类型');
    case 'group':
    default:
      return displayGroupName(target.group_name || '默认分组');
  }
}

export function groupByDimension(targets = [], mode = 'group') {
  const groups = {};
  for (const target of targets || []) {
    const key = groupKeyFor(target, mode);
    (groups[key] ||= []).push(target);
  }
  return groups;
}

export function groupByMenuHtml(selected = 'group', menuId = 'groupByMenu') {
  const current = GROUP_BY_OPTIONS.find((option) => option.id === selected) || GROUP_BY_OPTIONS[0];
  const options = GROUP_BY_OPTIONS.map((option) => {
    const active = option.id === current.id;
    return `<button type="button" role="option" aria-selected="${active}" class="group-by-option${active ? ' is-active' : ''}" data-group-value="${option.id}">${option.label}</button>`;
  }).join('');
  return `<div class="group-by-control" id="${menuId}"><span class="group-by-caption">分组方式</span><button type="button" class="group-by-trigger" aria-haspopup="listbox" aria-expanded="false"><span>${current.label}</span><i aria-hidden="true"></i></button><div class="group-by-menu" role="listbox" aria-label="分组方式" hidden>${options}</div></div>`;
}

export function lineTypeOptionsHtml(selected = '') {
  const selectedValue = String(selected || '').trim();
  const options = [...LINE_TYPE_OPTIONS];
  if (selectedValue && !options.some((opt) => opt.id === selectedValue)) {
    options.splice(1, 0, {
      id: selectedValue,
      label: LEGACY_LINE_TYPES.has(selectedValue) ? `${selectedValue}（旧数据）` : selectedValue,
    });
  }
  return options.map((opt) => {
    const sel = selectedValue === opt.id ? ' selected' : '';
    return `<option value="${opt.id}"${sel}>${opt.label}</option>`;
  }).join('');
}
