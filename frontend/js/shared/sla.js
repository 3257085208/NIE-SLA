export function targetSlaPercentage(targetId, days, summaries) {
  let total = 0;
  let ok = 0;

  for (const day of days || []) {
    const summary = summaries?.get?.(`${targetId}:${day}`);
    const dayTotal = Math.max(0, finiteNumber(summary?.total));
    if (!dayTotal) continue;

    total += dayTotal;
    ok += Math.min(dayTotal, Math.max(0, finiteNumber(summary?.ok_count)));
  }

  return total > 0 ? (ok / total) * 100 : null;
}

export function dailyFleetSlaSeries(targetIds, days, summaries) {
  const ids = [...new Set((targetIds || []).map((id) => String(id || '')).filter(Boolean))];
  return (days || []).map((day) => {
    const values = ids.map((targetId) => {
      const summary = summaries.get(`${targetId}:${day}`);
      const total = Number(summary?.total);
      const ok = Number(summary?.ok_count);
      if (!Number.isFinite(total) || total <= 0 || !Number.isFinite(ok)) return null;
      return Math.min(100, Math.max(0, ok / total * 100));
    }).filter((value) => value != null);
    return {
      day,
      value: values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null,
      target_count: values.length,
    };
  });
}

function finiteNumber(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? number : 0;
}
