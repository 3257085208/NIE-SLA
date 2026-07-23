export function formatDuration(sec) {
  let s = Math.max(0, Math.floor(Number(sec || 0)));

  const d = Math.floor(s / 86400);
  s %= 86400;

  const h = Math.floor(s / 3600);
  s %= 3600;

  const m = Math.floor(s / 60);
  s %= 60;

  if (d) return `${d}d ${h}h ${m}m`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${s}s`;

  return `${s}s`;
}
export function formatGb(gb) {
  const n = Number(gb || 0);
  return n >= 100 ? `${n.toFixed(0)} GB` : `${n.toFixed(1)} GB`;
}

export function fmtBytes(value) {
  const b = Number(value || 0);
  if (b >= 1024 ** 4) return `${(b / 1024 ** 4).toFixed(2)} TB`;
  if (b >= 1024 ** 3) return `${(b / 1024 ** 3).toFixed(1)} GB`;
  if (b >= 1024 ** 2) return `${(b / 1024 ** 2).toFixed(1)} MB`;
  if (b >= 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${b.toFixed(0)} B`;
}

export function fmtBytesPerSec(value) {
  const b = Number(value || 0);
  if (b >= 1024 ** 3) return `${(b / 1024 ** 3).toFixed(2)} GB/s`;
  if (b >= 1024 ** 2) return `${(b / 1024 ** 2).toFixed(2)} MB/s`;
  if (b >= 1024) return `${(b / 1024).toFixed(1)} KB/s`;
  return `${b.toFixed(0)} B/s`;
}

export function fmtSizeMB(mb) {
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb} MB`;
}

export function formatMachineUptime(sec) {
  let s = Math.max(0, Math.floor(Number(sec || 0)));
  const d = Math.floor(s / 86400);
  s %= 86400;
  const h = Math.floor(s / 3600);
  s %= 3600;
  const m = Math.floor(s / 60);
  if (d >= 30) {
    const mo = Math.floor(d / 30);
    const rd = d % 30;
    return rd ? `${mo}mo ${rd}d` : `${mo}mo`;
  }
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m`;
  return `${s}s`;
}

export function timeAgoSec(sec) {
  const diff = Math.max(0, Math.floor(Date.now() / 1000) - Number(sec || 0));
  if (!sec) return '-';
  if (diff < 60) return `${diff} 秒前`;
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
  return `${Math.floor(diff / 86400)} 天前`;
}

export function percent(ok, total) {
  const t = Number(total || 0);

  if (!t) {
    return '0.00';
  }

  return (Number(ok || 0) / t * 100).toFixed(2);
}

export function fmtTime(sec, mode = 'full') {
  if (!sec) {
    return '-';
  }

  const d = new Date(Number(sec) * 1000);

  if (mode === 'short') {
    return d.toLocaleString('zh-CN', {
      hour12: false,
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  return d.toLocaleString('zh-CN', {
    hour12: false,
  });
}

export function pad(n) {
  return String(n).padStart(2, '0');
}

export function cssEscape(value) {
  if (window.CSS && CSS.escape) {
    return CSS.escape(value);
  }

  return String(value).replace(/[^\x20-\x7E]|["#&'()*+,./:;<=>?@[\]^`{|}~]/g, function (ch) {
    var cp = ch.codePointAt(0);
    if (cp < 0x20 || cp > 0x7E) return '\\' + cp.toString(16) + ' ';
    return '\\' + ch;
  });
}

export function clampNumber(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function minMax(arr) {
  let min = Infinity, max = -Infinity;
  for (let i = 0; i < arr.length; i++) {
    if (arr[i] < min) min = arr[i];
    if (arr[i] > max) max = arr[i];
  }
  return { min, max };
}

export function downsample(arr, maxPoints) {
  if (arr.length <= maxPoints) return arr;
  const step = Math.ceil(arr.length / maxPoints);
  const out = [];
  for (let i = 0; i < arr.length; i += step) {
    const chunk = arr.slice(i, i + step);
    const avg = {};
    for (const key of Object.keys(chunk[0] || {})) {
      const vals = chunk.map(p => Number(p[key])).filter(Number.isFinite);
      avg[key] = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : chunk[0][key];
    }
    out.push(avg);
  }
  return out;
}

export function normalizeCityName(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, 64);
}

export function formatLocationLabel(countryName, city, fallback = '') {
  const country = String(countryName || '').trim();
  const cityName = normalizeCityName(city);
  if (country && cityName) {
    const countryKey = country.toLocaleLowerCase('zh-CN');
    const cityKey = cityName.toLocaleLowerCase('zh-CN');
    if (cityKey === countryKey || cityKey.includes(countryKey) || countryKey.includes(cityKey)) {
      return cityName;
    }
    return `${country} · ${cityName}`;
  }
  return country || cityName || String(fallback || '').trim();
}
