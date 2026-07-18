import { clamp, nowSec, sanitizeId } from '../utils.js';
import { readCheckBuckets } from './check-buckets.js';

export async function getLatencyHealth(env, url) {
  if (!env.DB) return { ok: false, error: '缺少 D1 的 DB 绑定' };

  const targetId = sanitizeId(url.searchParams.get('target_id') || '');
  const hours = clamp(Number(url.searchParams.get('hours') || 24), 1, 168);
  const maxGapSec = clamp(Number(url.searchParams.get('max_gap_sec') || 1800), 300, 86400);
  const cutoff = nowSec() - hours * 3600;

  const targetRows = targetId
    ? await env.DB.prepare(`SELECT id, name, interval_sec FROM targets WHERE id = ?`).bind(targetId).all()
    : await env.DB.prepare(`SELECT id, name, interval_sec FROM targets WHERE enabled = 1 ORDER BY group_name, name`).all();

  const targets = [];
  for (const target of targetRows.results || []) {
    const points = (await readCheckBuckets(env, target.id, Math.ceil(hours / 24) + 1))
      .filter(point => Number(point.checked_at || 0) >= cutoff)
      .sort((a, b) => Number(a.checked_at || 0) - Number(b.checked_at || 0));
    targets.push(analyzeLatencyTarget(target, points, maxGapSec));
  }

  return {
    ok: true,
    generated_at: new Date().toISOString(),
    hours,
    max_gap_sec: maxGapSec,
    summary: summarizeTargets(targets),
    targets,
  };
}

function summarizeTargets(targets) {
  return {
    targets: targets.length,
    affected_targets: targets.filter(row => row.previous_chart_breaks > 0 || row.current_chart_null_points > 0).length,
    total_points: targets.reduce((sum, row) => sum + row.total_points, 0),
    real_latency_points: targets.reduce((sum, row) => sum + row.real_latency_points, 0),
    missed_points: targets.reduce((sum, row) => sum + row.missed_points, 0),
    previous_chart_breaks: targets.reduce((sum, row) => sum + row.previous_chart_breaks, 0),
    current_chart_null_points: targets.reduce((sum, row) => sum + row.current_chart_null_points, 0),
    longest_gap_sec: targets.reduce((max, row) => Math.max(max, row.longest_gap_sec || 0), 0),
  };
}

function analyzeLatencyTarget(target, points, maxGapSec) {
  const real = points.filter(isRealLatencyPoint);
  const missed = points.filter(point => point.missed);
  const nullPoints = points.filter(point => !point.missed && !isRealLatencyPoint(point));
  const gaps = [];

  for (let i = 1; i < real.length; i += 1) {
    const prev = Number(real[i - 1].checked_at || 0);
    const next = Number(real[i].checked_at || 0);
    const gap = next - prev;
    if (gap > maxGapSec) {
      gaps.push({
        from: new Date(prev * 1000).toISOString(),
        to: new Date(next * 1000).toISOString(),
        sec: gap,
      });
    }
  }

  const latestRealAt = real.length ? Number(real[real.length - 1].checked_at || 0) : 0;
  return {
    id: target.id,
    name: target.name,
    interval_sec: Number(target.interval_sec || 300),
    total_points: points.length,
    real_latency_points: real.length,
    missed_points: missed.length,
    current_chart_null_points: nullPoints.length,
    previous_chart_breaks: gaps.length,
    longest_gap_sec: gaps.reduce((max, gap) => Math.max(max, gap.sec), 0),
    first_real_at: real.length ? new Date(Number(real[0].checked_at) * 1000).toISOString() : null,
    latest_real_at: latestRealAt ? new Date(latestRealAt * 1000).toISOString() : null,
    latest_real_age_sec: latestRealAt ? nowSec() - latestRealAt : null,
    gaps: gaps.slice(0, 20),
  };
}

function isRealLatencyPoint(point) {
  return !point.missed && Number(point.ok) === 1 && point.latency_ms != null && Number.isFinite(Number(point.latency_ms));
}
