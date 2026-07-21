export function normalizeChartRows(checks) {
  return (checks || [])
    .map((check) => ({
      x: Number(check.checked_at),
      ok: Number(check.ok) === 1,
      latency: Number(check.latency_ms),
      missed: Boolean(check.missed),
    }))
    .filter((point) => Number.isFinite(point.x))
    .sort((a, b) => a.x - b.x);
}

export function buildLinePoints(rows) {
  return (rows || [])
    .filter((row) => !row.missed)
    .map((row) => ({
      x: row.x,
      y: row.ok && Number.isFinite(row.latency) ? row.latency : null,
    }));
}

export function trimEmptyPointEdges(points) {
  const values = points || [];
  const first = values.findIndex((point) => Number.isFinite(point?.y));
  if (first < 0) return [];
  let last = values.length - 1;
  while (last > first && !Number.isFinite(values[last]?.y)) last -= 1;
  return values.slice(first, last + 1);
}

export function chartColorToRgb(color) {
  const value = String(color || "").trim();
  const hex = value.match(/^#?([0-9a-f]{6})$/i);
  if (hex) {
    const number = Number.parseInt(hex[1], 16);
    return { r: (number >> 16) & 255, g: (number >> 8) & 255, b: number & 255 };
  }
  const rgb = value.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
  if (rgb) return { r: Number(rgb[1]), g: Number(rgb[2]), b: Number(rgb[3]) };
  return { r: 47, g: 125, b: 246 };
}

export function hexToRgba(color, alpha) {
  const { r, g, b } = chartColorToRgb(color);
  return `rgba(${r},${g},${b},${alpha})`;
}

export function clampChartRange(min, max, fullMin, fullMax) {
  const span = Math.max(1, max - min);
  let nextMin = min;
  let nextMax = max;
  if (nextMin < fullMin) {
    nextMin = fullMin;
    nextMax = nextMin + span;
  }
  if (nextMax > fullMax) {
    nextMax = fullMax;
    nextMin = nextMax - span;
  }
  return { min: Math.max(fullMin, nextMin), max: Math.min(fullMax, nextMax) };
}

export function countChartGaps(checks, gapSec) {
  const timestamps = (checks || [])
    .map((check) => Number(check.checked_at))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  let gaps = 0;
  for (let i = 1; i < timestamps.length; i += 1) {
    if (timestamps[i] - timestamps[i - 1] > gapSec) gaps += 1;
  }
  return gaps;
}

export function countMissedChecks(checks) {
  return (checks || []).filter((check) => check?.missed).length;
}

export function filterChecksByRange(checks, range, currentSec = Date.now() / 1000) {
  const seconds = range === "month" ? 30 * 86400 : range === "week" ? 7 * 86400 : 24 * 3600;
  return (checks || []).filter((check) => {
    const timestamp = Number(check.checked_at);
    return Number.isFinite(timestamp) && timestamp >= currentSec - seconds;
  });
}
