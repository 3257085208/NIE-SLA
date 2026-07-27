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

function finiteNumber(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? number : 0;
}
