const INVALID_LINE_NAMES = new Set(['电信', '联通', '移动', '其他', '未知', '未识别', 'unknown', 'unidentified']);
const KNOWN_LINE_NAMES = new Map([
  ['163', '163'],
  ['9929', '9929'],
  ['10099', '10099'],
  ['4837', '4837'],
  ['cmi', 'CMI'],
  ['cmin2', 'CMIN2'],
  ['cmnet', 'CMNET'],
  ['cn2', 'CN2'],
  ['cn2 gt', 'CN2 GT'],
  ['cn2 gia', 'CN2 GIA'],
]);

function normalizeLine(value, carrier = '') {
  const raw = String(value || '')
    .trim()
    .replace(/^线路\s*[:：]?\s*/u, '')
    .replace(/^经由\s*[:：]?\s*/u, '')
    .replace(/\s+/g, ' ')
    .slice(0, 60);
  const key = raw.toLowerCase();
  return !raw || raw === carrier || INVALID_LINE_NAMES.has(key) ? '未识别' : (KNOWN_LINE_NAMES.get(key) || raw);
}

export function normalizeBackrouteEntries(backroute) {
  const routes = Array.isArray(backroute?.routes) ? backroute.routes : [];
  return routes.map((entry) => {
    if (!entry || typeof entry !== 'object') return null;
    const carrier = String(entry.carrier || '').trim();
    if (!['电信', '联通', '移动'].includes(carrier)) return null;
    const line = normalizeLine(entry.line, carrier);
    const raw = String(entry.raw || '').trim();
    if (!line && !raw) return null;
    return {
      carrier,
      line: line || '未识别',
      target: String(entry.target || '').trim(),
      confidence: String(entry.confidence || '').trim(),
    };
  }).filter(Boolean);
}
