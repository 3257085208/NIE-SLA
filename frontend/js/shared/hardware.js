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

export function hasTemperatureData(info = {}) {
  if (!canShowTemperature(info)) return false;
  if (['cpu_temp_c', 'gpu_temp_c', 'motherboard_temp_c', 'disk_temp_c', 'chipset_temp_c'].some(key => info?.[key] != null && Number.isFinite(Number(info[key])))) return true;
  return Array.isArray(info?.temperature_sensors) && info.temperature_sensors.some(sensor => sensor?.temp_c != null && Number.isFinite(Number(sensor.temp_c)));
}

export function hasGpuData(info = {}) {
  const name = String(info?.gpu_name || '').trim();
  const count = Number(info?.gpu_count || 0);
  const hasHardware = Boolean(name) || (Number.isFinite(count) && count > 0);
  if (!hasHardware) return false;
  if (info?.gpu_accessible === true) return true;
  if (info?.gpu_accessible === false) return false;



  if (isVirtualized(info)) {
    return ['gpu_util', 'gpu_temp_c'].some(key => info?.[key] != null && Number.isFinite(Number(info[key])));
  }
  return true;
}
