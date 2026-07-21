const BARE_METAL_LABELS = new Set([
  '',
  'bare metal',
  'bare-metal',
  'baremetal',
  'none',
  'physical',
]);

export function isVirtualized(info = {}) {
  const value = String(info?.virtualization || '').trim().toLowerCase();
  return Boolean(value) && !BARE_METAL_LABELS.has(value);
}

export function canShowTemperature(info = {}) {
  return !isVirtualized(info);
}
