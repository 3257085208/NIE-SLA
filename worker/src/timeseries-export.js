const MAX_EXPORT_POINTS_PER_BATCH = 10_000;
const MAX_EXPORT_ATTEMPTS = 12;

export function timeseriesExportEnabled(env) {
  return Boolean(String(env?.TIMESERIES_EXPORT_URL || '').trim());
}

export async function exportTelemetryHour(env, agentId, hour, pings) {
  const endpoint = String(env?.TIMESERIES_EXPORT_URL || '').trim();
  if (!endpoint) return { ok: true, enabled: false };
  const format = String(env?.TIMESERIES_EXPORT_FORMAT || 'victoriametrics').trim().toLowerCase();
  if (!['victoriametrics', 'influx'].includes(format)) throw new Error('time-series export format is invalid');
  const url = validateExportUrl(endpoint);
  const token = String(env?.TIMESERIES_EXPORT_TOKEN || '').trim();
  const points = Array.isArray(pings) ? pings : [];
  for (let offset = 0; offset < points.length; offset += MAX_EXPORT_POINTS_PER_BATCH) {
    const batch = points.slice(offset, offset + MAX_EXPORT_POINTS_PER_BATCH);
    const payload = format === 'influx'
      ? influxPayload(agentId, batch)
      : prometheusPayload(agentId, batch);
    let response;
    try {
      response = await fetch(url, {
        method: 'POST',
        redirect: 'manual',
        cache: 'no-store',
        signal: globalThis.AbortSignal.timeout(10_000),
        headers: {
          'content-type': format === 'influx' ? 'text/plain; charset=utf-8' : 'text/plain; version=0.0.4',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: payload,
      });
    } catch (_) {
      throw new Error('time-series export request failed');
    }
    if (!response.ok || response.status >= 300) {
      throw new Error(`time-series export HTTP ${response.status}`);
    }
  }
  return { ok: true, enabled: true, format, hour };
}

export function normalizeExportAttempt(value) {
  const attempts = Math.max(0, Math.floor(Number(value?.attempts || 0)));
  return {
    attempts,
    last_error: String(value?.last_error || '').slice(0, 240),
    next_at: Math.floor(Number(value?.next_at || 0)),
  };
}

export const maxExportAttempts = MAX_EXPORT_ATTEMPTS;

function validateExportUrl(value) {
  let url;
  try { url = new URL(value); } catch (_) { throw new Error('time-series export URL is invalid'); }
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new Error('time-series export URL must use HTTPS without embedded credentials');
  }
  return url.toString();
}

function influxPayload(agentId, pings) {
  return pings.map(point => {
    const tags = `nie_sla_ping,agent_id=${escapeInflux(agentId)},target_id=${escapeInflux(point?.target_id || '')}`;
    const fields = [`ok=${Number(point?.ok) === 1 ? 1 : 0}i`];
    if (Number(point?.ok) === 1 && Number.isFinite(Number(point?.latency_ms))) fields.push(`latency_ms=${Number(point.latency_ms)}`);
    return `${tags} ${fields.join(',')} ${Math.floor(Number(point?.ts || 0))}000000000`;
  }).join('\n');
}

function prometheusPayload(agentId, pings) {
  const out = [];
  for (const point of pings) {
    const labels = `agent_id="${escapeProm(String(agentId))}",target_id="${escapeProm(String(point?.target_id || ''))}"`;
    const ts = Math.floor(Number(point?.ts || 0)) * 1000;
    out.push(`nie_sla_ping_ok{${labels}} ${Number(point?.ok) === 1 ? 1 : 0} ${ts}`);
    if (Number(point?.ok) === 1 && Number.isFinite(Number(point?.latency_ms))) {
      out.push(`nie_sla_ping_latency_ms{${labels}} ${Number(point.latency_ms)} ${ts}`);
    }
  }
  return `${out.join('\n')}\n`;
}

function escapeInflux(value) {
  return String(value).replaceAll('\\', '\\\\').replaceAll(',', '\\,').replaceAll(' ', '\\ ').replaceAll('=', '\\=');
}

function escapeProm(value) {
  return String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n');
}
