import { clamp, dayFromSec, dayStartSec, isMissedMonitorPoint, nowSec, parseBoolean, sanitizeId } from './utils.js';
import { internalRequestAuthorized, internalRequestHeaders } from './auth.js';
import { readR2JsonResult, verifyR2Json } from './storage.js';
import { encodeJsonBody, httpMetadataFor } from './r2-body.js';
import { withS3Archive } from './r2s3.js';

const DAY_PREFIX = 'day:';
const SCHEMA = 'nie-sla-probe-history-day-v1';
const DEFAULT_MAX_POINTS = 2_000;
const DAY_RANGE_LIMIT = 90;
const MAX_MEM_DAY_ATTEMPTS = 3;
const MAX_ARCHIVE_DAY_ATTEMPTS = 3;
const DEAD_LETTER_PREFIX = 'dead-letter:day:';
const ARCHIVE_CONFIRM_WINDOW_SEC = 1_800;
const MAX_ARCHIVE_CONFIRM_FAILS = 8;
const ARCHIVE_READ_RETENTION_SEC = 4 * 86_400;
// The shared hub buffers every target in one instance; `|` cannot appear in a
// sanitized target id, so hub keys stay unambiguous.
const HUB_DAY_PREFIX = 'd:';
const HUB_DEAD_LETTER_PREFIX = 'dl:';
const MIGRATED_PREFIX = 'migrated:';
const MAX_ARCHIVE_WRITES_PER_ALARM = 10;

export const PROBE_HISTORY_HUB_INSTANCE = 'probe-history-hub';

function hubDayKey(targetId, day) {
  return `${HUB_DAY_PREFIX}${sanitizeId(targetId)}|${String(day).slice(0, 10)}`;
}

function hubDeadLetterKey(targetId, day) {
  return `${HUB_DEAD_LETTER_PREFIX}${sanitizeId(targetId)}|${String(day).slice(0, 10)}`;
}

function parseHubKey(key) {
  const raw = String(key);
  const body = raw.startsWith(HUB_DAY_PREFIX)
    ? raw.slice(HUB_DAY_PREFIX.length)
    : raw.startsWith(HUB_DEAD_LETTER_PREFIX)
      ? raw.slice(HUB_DEAD_LETTER_PREFIX.length)
      : raw;
  const index = body.indexOf('|');
  if (index <= 0) return null;
  const targetId = sanitizeId(body.slice(0, index));
  const day = body.slice(index + 1);
  return { targetId, day };
}

/**
 * Probe history moved from one Durable Object per target to a single shared
 * hub instance: region probe batches now append every due target through one
 * DO request, and the hub writes the R2 day object per target. The legacy
 * per-target instances keep serving reads until each target is lazily
 * migrated into the hub. D1 remains the compatibility fallback for old rows
 * and for deployments without this binding.
 */
export class ProbeHistoryBuffer {
  constructor(state, env) {
    this.state = state;
    this.env = withS3Archive(env);
    this.memDays = new Map();
    this.memDayAttempts = new Map();
    this.archiveAttempts = new Map();
    this.memMetaPut = false;
    this.isHub = String(state?.id?.name || '') === PROBE_HISTORY_HUB_INSTANCE;
    this.migratedTargets = new Set();
  }

  async fetch(request) {
    if (!internalRequestAuthorized(request, this.env)) return json({ ok: false, error: '未授权' }, 401);
    const url = new URL(request.url);
    if (request.method === 'POST' && url.pathname === '/append') {
      return json(await this.append(await request.json()));
    }
    if (request.method === 'GET' && url.pathname === '/read') {
      return json(await this.read({
        targetId: sanitizeId(url.searchParams.get('target_id') || '') || null,
        fromDay: url.searchParams.get('from_day'),
        toDay: url.searchParams.get('to_day'),
        since: Number(url.searchParams.get('since') || 0),
        until: Number(url.searchParams.get('until') || nowSec()),
      }));
    }
    if (request.method === 'GET' && url.pathname === '/summary') {
      return json(await this.summary(
        String(url.searchParams.get('day') || ''),
        Number(url.searchParams.get('before') || Number.MAX_SAFE_INTEGER),
        sanitizeId(url.searchParams.get('target_id') || '') || null,
      ));
    }
    if (request.method === 'GET' && url.pathname === '/dead-letter') {
      return json(await this.listDeadLetters(
        sanitizeId(url.searchParams.get('target_id') || '') || null,
        url.searchParams.get('limit'),
      ));
    }
    if (request.method === 'POST' && url.pathname === '/dead-letter/replay') {
      const body = await request.json().catch(() => ({}));
      const day = String(body?.day || '');
      if (!isDay(day)) return json({ ok: false, error: '无效的 dead-letter 日期' }, 400);
      try {
        return json(await this.replayDeadLetter(day, sanitizeId(body?.target_id || '') || null));
      } catch (error) {
        console.error(`replay probe day ${day} dead-letter failed:`, String(error?.message || error));
        return json({ ok: false, error: 'dead-letter 重放失败，原记录仍保留' }, 503);
      }
    }
    if (request.method === 'POST' && url.pathname === '/dead-letter/drain') {
      const body = await request.json().catch(() => ({}));
      return json(await this.drainDeadLetters(
        sanitizeId(body?.target_id || '') || null,
        body?.limit,
      ));
    }
    if (request.method === 'GET' && url.pathname === '/export') {
      return json(await this.exportLegacyBuffers());
    }
    if (request.method === 'POST' && url.pathname === '/delete') {
      await this.state.storage.deleteAll();
      return json({ ok: true });
    }
    return new Response(null, { status: 404 });
  }

  // Raw storage snapshot used by the shared hub to migrate a legacy per-target
  // instance without replaying archived R2 objects.
  async exportLegacyBuffers() {
    const meta = await this.state.storage.get('meta');
    const days = new Map();
    const dayRows = await this.state.storage.list({ prefix: DAY_PREFIX });
    for (const [key, value] of dayRows) {
      const day = String(key).slice(DAY_PREFIX.length);
      if (!isDay(day)) continue;
      const points = Array.isArray(value?.points) ? value.points : [];
      days.set(day, {
        day,
        target_id: sanitizeId(value?.target_id || meta?.target_id || ''),
        points: [...(days.get(day)?.points || []), ...points],
        archived_at: Number(value?.archived_at || 0) || null,
        confirm_fails: Number(value?.confirm_fails || 0) || 0,
      });
    }
    for (const [key, points] of this.memDays) {
      const parsed = parseHubKey(key);
      const day = parsed?.day || String(key).slice(String(key).indexOf('|') + 1);
      if (!isDay(day)) continue;
      days.set(day, {
        day,
        target_id: sanitizeId(parsed?.targetId || meta?.target_id || ''),
        points: [...(days.get(day)?.points || []), ...(Array.isArray(points) ? points : [])],
      });
    }
    const deadLetters = [];
    const deadRows = await this.state.storage.list({ prefix: DEAD_LETTER_PREFIX });
    for (const [key, value] of deadRows) {
      const day = String(key).slice(DEAD_LETTER_PREFIX.length);
      if (!isDay(day)) continue;
      deadLetters.push({ day, target_id: sanitizeId(value?.target_id || meta?.target_id || ''), points: Array.isArray(value?.points) ? value.points : [], saved_at: value?.saved_at || null });
    }
    return { ok: true, days: [...days.values()], dead_letters: deadLetters };
  }

  async append(body) {
    const entries = Array.isArray(body?.targets)
      ? body.targets.map(item => ({ targetId: sanitizeId(item?.target_id), writes: item?.writes }))
      : [{ targetId: sanitizeId(body?.target_id), writes: body?.writes }];
    let days = 0;
    let points = 0;
    let targets = 0;
    for (const entry of entries) {
      if (!entry.targetId || !Array.isArray(entry.writes) || !entry.writes.length) continue;
      if (this.isHub) await this.ensureLegacyBufferMigrated(entry.targetId).catch(() => {});
      const result = await this.appendLocal(entry.targetId, entry.writes);
      if (!result.accepted) continue;
      targets += 1;
      days += result.days;
      points += result.points;
    }
    if (!targets) return { ok: true, skipped: true };
    await this.scheduleFlush(dayFromSec(nowSec(), this.env), this.memDays.size > 0);
    return { ok: true, target_id: entries.length === 1 ? entries[0].targetId : null, targets, days, points };
  }

  async appendLocal(targetId, writes) {
    if (!this.memMetaPut && !this.isHub) {
      await this.state.storage.put('meta', { target_id: targetId, schema: SCHEMA });
      this.memMetaPut = true;
    }
    const incoming = new Map();
    for (const item of Array.isArray(writes) ? writes : []) {
      const point = normalizeProbePoint(item?.point || item);
      const day = String(item?.day || dayFromSec(point?.checked_at || 0, this.env)).slice(0, 10);
      if (!point || !isDay(day)) continue;
      const list = incoming.get(day) || [];
      list.push(point);
      incoming.set(day, list);
    }
    if (!incoming.size) return { accepted: false, days: 0, points: 0 };
    for (const [day, points] of incoming) {
      const key = `${targetId}|${day}`;
      this.memDays.set(key, (this.memDays.get(key) || []).concat(points));
    }
    return { accepted: true, days: incoming.size, points: [...incoming.values()].reduce((sum, rows) => sum + rows.length, 0) };
  }

  async read({ targetId = null, fromDay, toDay, since = 0, until = nowSec() } = {}) {
    const start = Math.floor(Number(since) || 0);
    const end = Math.floor(Number(until) || nowSec());
    const legacyTargetId = this.isHub
      ? sanitizeId(targetId || '')
      : sanitizeId(targetId || (await this.state.storage.get('meta'))?.target_id || '');
    if (this.isHub && !legacyTargetId) return { ok: true, points: [] };
    if (this.isHub) await this.ensureLegacyBufferMigrated(legacyTargetId).catch(() => {});
    const days = boundedDayRange(fromDay, toDay, this.env, start, end);
    const stateByDay = new Map();
    const deadByDay = new Map();
    if (this.isHub) {
      const dayRows = await this.state.storage.list({ prefix: `${HUB_DAY_PREFIX}${legacyTargetId}|` });
      for (const [key, value] of dayRows) {
        const parsed = parseHubKey(key);
        if (parsed) stateByDay.set(parsed.day, value);
      }
      const deadRows = await this.state.storage.list({ prefix: `${HUB_DEAD_LETTER_PREFIX}${legacyTargetId}|` });
      for (const [key, value] of deadRows) {
        const parsed = parseHubKey(key);
        if (parsed) deadByDay.set(parsed.day, value);
      }
    } else {
      const stateRows = await this.state.storage.list({ prefix: DAY_PREFIX });
      for (const [key, value] of stateRows) stateByDay.set(String(key).slice(DAY_PREFIX.length), value);
    }

    const points = [];
    for (const day of days) {
      const live = stateByDay.get(day);
      const resolvedTargetId = this.isHub ? legacyTargetId : sanitizeId(live?.target_id || legacyTargetId);
      let archived = null;
      try {
        archived = await this.readArchiveDay(day, resolvedTargetId || null);
      } catch (error) {
        console.error(`read probe archive day ${day} failed:`, String(error?.message || error));
      }
      const memPoints = resolvedTargetId ? this.memDays.get(`${resolvedTargetId}|${day}`) || [] : [];
      const deadLetter = this.isHub
        ? deadByDay.get(day) || null
        : await this.state.storage.get(`${DEAD_LETTER_PREFIX}${day}`).catch(() => null);
      const merged = mergeDay(archived, resolvedTargetId, day, [
        ...(Array.isArray(live?.points) ? live.points : []),
        ...memPoints,
        ...(Array.isArray(deadLetter?.points) ? deadLetter.points : []),
      ], this.env);
      for (const point of merged.points || []) {
        if (Number(point.checked_at) >= start && Number(point.checked_at) <= end) points.push(toPublicPoint(point));
      }
    }
    points.sort((a, b) => Number(a.checked_at) - Number(b.checked_at));
    return { ok: true, points };
  }

  async summary(day, beforeAt = Number.MAX_SAFE_INTEGER, targetId = null) {
    if (!isDay(day)) return { ok: true, day: null, total: 0, ok_count: 0, sum_latency_ms: 0 };
    const result = await this.read({
      targetId,
      fromDay: day,
      toDay: day,
      since: dayStartSec(day, this.env),
      until: Math.min(Number(beforeAt) || Number.MAX_SAFE_INTEGER, dayStartSec(day, this.env) + 86400 - 1),
    });
    return { ok: true, day, ...summarizePoints(result.points) };
  }

  async listDeadLetters(targetId = null, limit = 50) {
    const boundedLimit = clamp(Number(limit || 50), 1, 100);
    // In hub mode an empty target means "every target"; sanitizeId never returns
    // an empty string, so only sanitize when a target was actually provided.
    const scoped = this.isHub && targetId ? sanitizeId(targetId) : '';
    const meta = this.isHub ? null : await this.state.storage.get('meta');
    const rows = this.isHub
      ? await this.state.storage.list({
        prefix: scoped ? `${HUB_DEAD_LETTER_PREFIX}${scoped}|` : HUB_DEAD_LETTER_PREFIX,
        limit: boundedLimit,
      })
      : await this.state.storage.list({ prefix: DEAD_LETTER_PREFIX, limit: boundedLimit });
    const deadLetters = [...rows].map(([key, value]) => {
      const parsed = this.isHub ? parseHubKey(key) : null;
      return {
        day: this.isHub ? parsed?.day : String(key).slice(DEAD_LETTER_PREFIX.length),
        target_id: this.isHub ? String(parsed?.targetId || '') : String(value?.target_id || meta?.target_id || ''),
        points: Array.isArray(value?.points) ? value.points.length : 0,
        saved_at: value?.saved_at || null,
      };
    }).filter((item) => isDay(item.day));
    return { ok: true, target_id: this.isHub ? scoped : String(meta?.target_id || ''), dead_letters: deadLetters };
  }

  async replayDeadLetter(day, targetId = null) {
    const scoped = this.isHub && targetId ? sanitizeId(targetId) : '';
    const key = this.isHub ? hubDeadLetterKey(scoped, day) : `${DEAD_LETTER_PREFIX}${day}`;
    const entry = await this.state.storage.get(key);
    if (!entry) return { ok: true, day, replayed: false, reason: 'not_found' };
    const points = Array.isArray(entry.points) ? entry.points : [];
    await this.mergeArchiveDay(entry.target_id || scoped || '', day, points);
    await this.state.storage.delete(key);
    return { ok: true, day, replayed: true, points: points.length };
  }

  async drainDeadLetters(targetId = null, limit = 25) {
    const boundedLimit = clamp(Number(limit || 25), 1, 25);
    const scoped = this.isHub && targetId ? sanitizeId(targetId) : '';
    const rows = this.isHub
      ? await this.state.storage.list({
        prefix: scoped ? `${HUB_DEAD_LETTER_PREFIX}${scoped}|` : HUB_DEAD_LETTER_PREFIX,
        limit: boundedLimit,
      })
      : await this.state.storage.list({ prefix: DEAD_LETTER_PREFIX, limit: boundedLimit });
    const drained = [];
    const failed = [];
    for (const [key] of rows) {
      const parsed = this.isHub ? parseHubKey(key) : null;
      const day = this.isHub ? parsed?.day : String(key).slice(DEAD_LETTER_PREFIX.length);
      if (!isDay(day)) continue;
      try {
        const result = await this.replayDeadLetter(day, scoped || parsed?.targetId || null);
        if (result.replayed) drained.push(result);
      } catch (error) {
        failed.push({ day, error: '重放失败，原记录仍保留' });
        console.error(`drain probe day ${day} dead-letter failed:`, String(error?.message || error));
      }
    }
    return { ok: true, drained, failed, processed: drained.length + failed.length };
  }

  async flushCompletedDays(currentDay = dayFromSec(nowSec(), this.env)) {
    if (!this.env.ARCHIVE) return { ok: true, skipped: true, reason: 'missing_archive' };
    const rows = await this.state.storage.list({ prefix: this.isHub ? HUB_DAY_PREFIX : DAY_PREFIX });
    let flushed = 0;
    let confirmPending = false;
    // Bound R2 work per alarm so a large hub backlog is spread across alarms
    // instead of risking one oversized invocation.
    let archiveBudget = MAX_ARCHIVE_WRITES_PER_ALARM;
    const spendArchiveBudget = () => {
      if (archiveBudget <= 0) { confirmPending = true; return false; }
      archiveBudget -= 1;
      return true;
    };
    for (const [key, value] of rows) {
      const parsed = this.isHub ? parseHubKey(key) : null;
      const day = this.isHub ? parsed?.day : String(key).slice(DAY_PREFIX.length);
      const targetId = sanitizeId((this.isHub ? parsed?.targetId : value?.target_id) || '');
      if (!isDay(day) || day >= currentDay) continue;
      const points = Array.isArray(value?.points) ? value.points : [];
      const archivedAt = Number(value?.archived_at || 0);
      if (archivedAt && nowSec() - archivedAt < ARCHIVE_CONFIRM_WINDOW_SEC) {
        confirmPending = true;
        continue;
      }
      try {
        if (archivedAt) {
          if (!spendArchiveBudget()) continue;
          if (await this.archiveDayPersisted(targetId, day)) {
            if (nowSec() - dayStartSec(day, this.env) >= ARCHIVE_READ_RETENTION_SEC) {
              this.archiveAttempts.delete(day);
              await this.state.storage.delete(key);
              flushed += 1;
            } else {
              confirmPending = true;
            }
            continue;
          }
          const confirmFails = Number(value?.confirm_fails || 0) + 1;
          if (confirmFails >= MAX_ARCHIVE_CONFIRM_FAILS) {
            const saved = await this.writeDeadLetterDay(targetId, day, points);
            if (saved) {
              console.error(`probe day ${day} archive never persisted; moved to dead-letter after ${confirmFails} confirm failures`);
              this.archiveAttempts.delete(day);
              await this.state.storage.delete(key);
            } else {
              this.archiveAttempts.set(day, MAX_ARCHIVE_DAY_ATTEMPTS);
            }
            continue;
          }
          await this.mergeArchiveDay(targetId, day, points);
          await this.state.storage.put(key, { ...value, archived_at: nowSec(), confirm_fails: confirmFails });
          confirmPending = true;
          continue;
        }
        if (!spendArchiveBudget()) continue;
        await this.mergeArchiveDay(targetId, day, points);
        await this.state.storage.put(key, { ...value, archived_at: nowSec(), confirm_fails: 0 });
        confirmPending = true;
      } catch (error) {
        const attempts = Number(this.archiveAttempts.get(day) || 0) + 1;
        if (attempts >= MAX_ARCHIVE_DAY_ATTEMPTS) {
          const saved = await this.writeDeadLetterDay(targetId, day, points);
          if (saved) {
            console.error(`probe day ${day} moved to durable dead-letter storage after ${attempts} archive attempts`);
            this.archiveAttempts.delete(day);
            await this.state.storage.delete(key);
          } else {
            console.error(`probe day ${day} remains queued after ${attempts} archive attempts:`, String(error?.message || error));
            this.archiveAttempts.set(day, attempts);
          }
        } else {
          this.archiveAttempts.set(day, attempts);
          confirmPending = true;
        }
      }
    }
    let replayed = 0;
    let deadLettersPending = false;
    try {
      // Hub mode stores dead letters under a per-target prefix: drain across all
      // targets (targetId=null) with the per-alarm budget as the limit, and count
      // pending entries with the same prefix the hub actually writes.
      const replay = await this.drainDeadLetters(null, 3);
      replayed = Array.isArray(replay?.drained) ? replay.drained.length : 0;
      const remaining = await this.state.storage.list({
        prefix: this.isHub ? HUB_DEAD_LETTER_PREFIX : DEAD_LETTER_PREFIX,
        limit: 1,
      });
      deadLettersPending = remaining.size > 0;
    } catch (error) {
      console.error('probe dead-letter auto drain failed:', String(error?.message || error));
      deadLettersPending = true;
    }
    return { ok: true, flushed, replayed, dead_letters_pending: deadLettersPending, confirm_pending: confirmPending };
  }

  async archiveDayPersisted(targetId, day) {
    const meta = await this.state.storage.get('meta');
    const resolvedTargetId = sanitizeId(targetId || meta?.target_id);
    try {
      const key = probeHistoryKey(this.env, resolvedTargetId, day);
      if (typeof this.env.ARCHIVE.head === 'function' && !(await this.env.ARCHIVE.head(key))) return false;
      const payload = await verifyR2Json(this.env, key, (value) => value && typeof value === 'object' && !Array.isArray(value)
        && String(value.target_id || '') === resolvedTargetId && String(value.day || '') === day && Array.isArray(value.points));
      return Boolean(payload);
    } catch (_) {
      return false;
    }
  }

  async alarm() {
    let pending = this.memDays.size > 0;
    try {
      await this.flushMemDays();
    } catch (error) {
      console.error('flush mem probe days failed:', String(error?.message || error));
      pending = true;
    }
    let deadLettersPending = false;
    let confirmPending = false;
    try {
      const result = await this.flushCompletedDays(dayFromSec(nowSec(), this.env));
      deadLettersPending = Boolean(result?.dead_letters_pending);
      confirmPending = Boolean(result?.confirm_pending);
    } catch (error) {
      console.error('flush completed probe days failed:', String(error?.message || error));
      deadLettersPending = true;
    }
    await this.scheduleFlush(dayFromSec(nowSec(), this.env), pending || deadLettersPending || confirmPending);
  }

  async flushMemDays() {
    if (!this.memDays.size) return;
    const currentDay = dayFromSec(nowSec(), this.env);
    const failed = new Map();
    for (const [memKey, points] of this.memDays) {
      const parsed = parseHubKey(memKey);
      const targetId = parsed?.targetId || await this.memTargetId();
      const day = parsed?.day || String(memKey).slice(String(memKey).indexOf('|') + 1);
      if (!isDay(day)) continue;
      const storageKey = this.isHub ? hubDayKey(targetId, day) : `${DAY_PREFIX}${day}`;
      try {
        if (day < currentDay && this.env.ARCHIVE) {
          await this.mergeArchiveDay(targetId, day, points);
          const existing = await this.state.storage.get(storageKey);
          await this.state.storage.put(storageKey, { ...(existing || {}), target_id: targetId, day, points, archived_at: nowSec(), confirm_fails: 0 });
          this.memDayAttempts.delete(memKey);
          continue;
        }
        const existing = await this.state.storage.get(storageKey);
        const merged = mergeDay(existing, targetId, day, points, this.env);
        await this.state.storage.put(storageKey, merged);
        this.memDayAttempts.delete(memKey);
      } catch (error) {
        const attempts = Number(this.memDayAttempts.get(memKey) || 0) + 1;
        if (attempts >= MAX_MEM_DAY_ATTEMPTS) {
          const saved = await this.writeDeadLetterDay(targetId, day, points);
          if (saved) {
            console.error(`probe day ${day} moved to durable dead-letter storage after ${attempts} flush attempts`);
            this.memDayAttempts.delete(memKey);
            continue;
          }
          console.error(`probe day ${day} remains queued after ${attempts} flush attempts:`, String(error?.message || error));
        }
        this.memDayAttempts.set(memKey, attempts);
        failed.set(memKey, points);
      }
    }
    this.memDays = failed;
  }

  async memTargetId() {
    const meta = await this.state.storage.get('meta');
    return sanitizeId(meta?.target_id);
  }

  async writeDeadLetterDay(targetId, day, points) {
    try {
      const key = this.isHub ? hubDeadLetterKey(targetId, day) : `${DEAD_LETTER_PREFIX}${day}`;
      const existing = await this.state.storage.get(key);
      const merged = mergeDay(existing, targetId, day, [
        ...(Array.isArray(existing?.points) ? existing.points : []),
        ...(Array.isArray(points) ? points : []),
      ], this.env);
      await this.state.storage.put(key, {
        ...merged,
        dead_letter: true,
        saved_at: new Date().toISOString(),
      });
      return true;
    } catch (error) {
      console.error(`persist probe day ${day} dead-letter failed:`, String(error?.message || error));
      return false;
    }
  }

  // Migration from the former per-target buffers: the first hub append or read
  // for a target copies its raw storage snapshot and dead-letters, then drops
  // the legacy instance. Failures are retried on the next call.
  async ensureLegacyBufferMigrated(rawTargetId) {
    if (!this.isHub) return;
    const targetId = sanitizeId(rawTargetId);
    if (!targetId || !this.env.PROBE_HISTORY) return;
    if (this.migratedTargets.has(targetId)) return;
    const flagKey = `${MIGRATED_PREFIX}${targetId}`;
    try {
      if (await this.state.storage.get(flagKey)) {
        this.migratedTargets.add(targetId);
        return;
      }
    } catch (_) {}
    try {
      const legacy = this.env.PROBE_HISTORY.get(this.env.PROBE_HISTORY.idFromName(`probe:${targetId}`));
      const response = await legacy.fetch('https://nie-sla.internal/export', { headers: internalRequestHeaders(this.env) });
      if (!response.ok) {
        // A failed export must not be recorded as migrated: the legacy instance
        // still holds the only copy of any unarchived points, so retry on the
        // next append/read instead of abandoning them.
        console.error(`probe history hub migration deferred: legacy export HTTP ${response.status}`);
        return;
      }
      const body = await response.json().catch(() => null);
      if (!body || !Array.isArray(body.days) || !Array.isArray(body.dead_letters)) {
        console.error('probe history hub migration deferred: invalid legacy export payload');
        return;
      }
      for (const item of body.days) {
        const day = String(item?.day || '').slice(0, 10);
        const points = Array.isArray(item?.points) ? item.points : [];
        if (!isDay(day) || !points.length) continue;
        await this.appendLocal(targetId, points.map(point => ({ day, point })));
      }
      for (const item of body.dead_letters) {
        const day = String(item?.day || '').slice(0, 10);
        if (!isDay(day)) continue;
        await this.state.storage.put(hubDeadLetterKey(targetId, day), {
          target_id: targetId,
          day,
          points: Array.isArray(item?.points) ? item.points : [],
          dead_letter: true,
          saved_at: item?.saved_at || new Date().toISOString(),
        });
      }
      await legacy.fetch('https://nie-sla.internal/delete', { method: 'POST', headers: internalRequestHeaders(this.env) }).catch(() => {});
    } catch (error) {
      console.error('probe history hub migration deferred:', String(error?.message || error));
      return;
    }
    await this.state.storage.put(flagKey, nowSec()).catch(() => {});
    this.migratedTargets.add(targetId);
    if (this.memDays.size > 0) {
      // Migrated points live in memory until an append or alarm flushes them;
      // schedule one now so a DO eviction cannot drop them.
      await this.scheduleFlush(dayFromSec(nowSec(), this.env), true).catch(() => {});
    }
  }

  async scheduleFlush(currentDay, memPending = false) {
    if (typeof this.state.storage.setAlarm !== 'function') return;
    const nextDay = addDays(currentDay, 1);
    const nextBoundary = dayStartSec(nextDay, this.env) + 300;
    const currentAlarm = await this.state.storage.getAlarm?.();
    if (memPending) {
      const soon = Date.now() + 30 * 60 * 1000;
      if (currentAlarm == null || currentAlarm > soon) await this.state.storage.setAlarm(soon);
      return;
    }
    const nextAlarm = nextBoundary * 1000;
    if (currentAlarm == null || currentAlarm < Date.now() || currentAlarm > nextAlarm) await this.state.storage.setAlarm(nextAlarm);
  }

  async mergeArchiveDay(targetId, day, points) {
    if (!this.env.ARCHIVE) throw new Error('缺少 R2 的 ARCHIVE 绑定');
    const meta = await this.state.storage.get('meta');
    const resolvedTargetId = sanitizeId(targetId || meta?.target_id);
    const key = probeHistoryKey(this.env, resolvedTargetId, day);
    const existing = await this.readArchiveDay(day, resolvedTargetId);
    const merged = mergeDay(existing, resolvedTargetId, day, points, this.env);
    const { body, bytes, encoding } = await encodeJsonBody({
      schema: SCHEMA,
      target_id: merged.target_id,
      day,
      updated_at: new Date().toISOString(),
      points: merged.points,
    });
    await this.env.ARCHIVE.put(key, body, {
      httpMetadata: httpMetadataFor(encoding),
      customMetadata: { schema: SCHEMA, target_id: merged.target_id, day, encoding: encoding || 'none' },
    });
    if (typeof this.env.ARCHIVE.head === 'function') {
      const verify = await this.env.ARCHIVE.head(key);
      if (!verify) throw new Error(`R2 probe history write did not persist (${resolvedTargetId} ${day})`);
      if (Number.isFinite(Number(verify.size)) && Number(verify.size) !== bytes) throw new Error(`R2 probe history size mismatch (${resolvedTargetId} ${day} expected ${bytes}, got ${verify.size})`);
    }
    await verifyR2Json(this.env, key, (value) => value?.schema === SCHEMA
      && String(value.target_id || '') === resolvedTargetId
      && String(value.day || '') === day
      && Array.isArray(value.points));
  }

  async readArchiveDay(day, targetId = null) {
    if (!this.env.ARCHIVE) return null;
    const meta = await this.state.storage.get('meta');
    const resolvedTargetId = sanitizeId(targetId || meta?.target_id);
    const result = await readR2JsonResult({ ARCHIVE: this.env.ARCHIVE }, probeHistoryKey(this.env, resolvedTargetId, day));
    if (!result.ok) throw new Error(`R2 probe history read failed (${day}): ${result.error}`);
    if (!result.found) return null;
    if (!result.value || typeof result.value !== 'object' || Array.isArray(result.value)) throw new Error(`R2 probe history object is invalid (${day})`);
    return result.value;
  }
}

export function probeHistoryEnabled(env = {}) {
  return Boolean(env.PROBE_HISTORY) && parseBoolean(env.PROBE_HISTORY_BUFFER ?? true, true);
}

function probeHistoryHubStub(env) {
  return env.PROBE_HISTORY.get(env.PROBE_HISTORY.idFromName(PROBE_HISTORY_HUB_INSTANCE));
}

export async function appendBufferedProbeHistory(env, targetId, bucketWrites) {
  if (!probeHistoryEnabled(env) || !bucketWrites?.length) return { ok: true, skipped: true, reason: 'disabled' };
  const response = await probeHistoryHubStub(env).fetch('https://nie-sla.internal/append', {
    method: 'POST',
    headers: internalRequestHeaders(env),
    body: JSON.stringify({ target_id: targetId, writes: bucketWrites }),
  });
  if (!response.ok) throw new Error(`SLA 历史缓冲写入失败：HTTP ${response.status}`);
  const result = await response.json();
  console.log(JSON.stringify({ diag: 'ph-append', target: targetId, days: result?.days, points: result?.points, skipped: result?.skipped || false }));
  return result;
}

// One region probe batch appends every due target through a single DO request
// instead of one request per target.
export async function appendBufferedProbeHistoryBatch(env, entries) {
  if (!probeHistoryEnabled(env) || !entries?.length) return { ok: true, skipped: true, reason: 'disabled' };
  const response = await probeHistoryHubStub(env).fetch('https://nie-sla.internal/append', {
    method: 'POST',
    headers: internalRequestHeaders(env),
    body: JSON.stringify({ targets: entries }),
  });
  if (!response.ok) throw new Error(`SLA 历史缓冲批量写入失败：HTTP ${response.status}`);
  const result = await response.json();
  console.log(JSON.stringify({ diag: 'ph-append-batch', targets: entries.length, days: result?.days, points: result?.points, skipped: result?.skipped || false }));
  return result;
}

export async function readBufferedProbeHistory(env, targetId, since, until, fromDay = null, toDay = null) {
  if (!probeHistoryEnabled(env)) return [];
  const url = new URL('https://nie-sla.internal/read');
  url.searchParams.set('target_id', String(targetId));
  url.searchParams.set('since', String(Math.floor(Number(since) || 0)));
  url.searchParams.set('until', String(Math.floor(Number(until) || nowSec())));
  if (fromDay) url.searchParams.set('from_day', String(fromDay));
  if (toDay) url.searchParams.set('to_day', String(toDay));
  const response = await probeHistoryHubStub(env).fetch(url.toString(), { headers: internalRequestHeaders(env) });
  if (!response.ok) throw new Error(`SLA 历史缓冲读取失败：HTTP ${response.status}`);
  const body = await response.json().catch(() => ({}));
  console.log(JSON.stringify({ diag: 'ph-read', target: targetId, points: Array.isArray(body?.points) ? body.points.length : -1 }));
  return Array.isArray(body?.points) ? body.points : [];
}

export async function readBufferedProbeDaySummary(env, targetId, day, beforeAt) {
  if (!probeHistoryEnabled(env)) return null;
  const url = new URL('https://nie-sla.internal/summary');
  url.searchParams.set('target_id', String(targetId));
  url.searchParams.set('day', String(day));
  url.searchParams.set('before', String(Math.floor(Number(beforeAt) || Number.MAX_SAFE_INTEGER)));
  const response = await probeHistoryHubStub(env).fetch(url.toString(), { headers: internalRequestHeaders(env) });
  if (!response.ok) throw new Error(`SLA 历史缓冲汇总读取失败：HTTP ${response.status}`);
  const body = await response.json().catch(() => null);
  return body?.ok ? { total: Number(body.total || 0), ok_count: Number(body.ok_count || 0), sum_latency_ms: Number(body.sum_latency_ms || 0) } : null;
}

function json(value, status = 200) {
  return Response.json(value, { status, headers: { 'cache-control': 'no-store' } });
}

function probeHistoryKey(env, targetId, day) {
  const prefix = String(env.PROBE_HISTORY_R2_PREFIX || 'probe-history-v1').replace(/^\/+|\/+$/g, '');
  return `${prefix}/${sanitizeId(targetId || 'target')}/${day}.json`;
}

function normalizeProbePoint(point) {
  const checkedAt = Math.floor(Number(point?.checked_at || 0));
  if (!Number.isFinite(checkedAt) || checkedAt <= 0) return null;
  const inputError = point?.error ?? point?.last_error;
  const missed = isMissedMonitorPoint({ ...point, error: inputError });
  const total = missed ? Math.max(1, Number(point?.total || 0) || 1) : Math.max(0, Number(point?.total == null ? 1 : point.total) || 0);
  const inputOk = point?.ok ?? point?.last_ok;
  const okCount = missed ? 0 : Math.max(0, Number(point?.ok_count == null ? (inputOk ? 1 : 0) : point.ok_count) || 0);
  const inputLatency = point?.latency_ms ?? point?.last_latency_ms;
  const latency = missed || inputLatency == null ? null : Number(inputLatency);
  const finiteLatency = Number.isFinite(latency) ? latency : null;
  const sumLatency = missed ? 0 : (Number.isFinite(Number(point?.sum_latency_ms)) ? Math.max(0, Number(point.sum_latency_ms)) : (finiteLatency == null ? 0 : finiteLatency * okCount));
  return {
    checked_at: checkedAt,
    total,
    ok_count: okCount,
    sum_latency_ms: sumLatency,
    last_ok: missed ? 0 : (inputOk == null ? 0 : Number(inputOk) ? 1 : 0),
    last_latency_ms: finiteLatency,
    last_status_code: missed || (point?.status_code ?? point?.last_status_code) == null ? null : Number(point.status_code ?? point.last_status_code),
    last_error: inputError == null ? null : String(inputError).slice(0, 500),
    probe_region: String(point?.probe_region || 'auto').slice(0, 32),
    cf_colo: point?.cf_colo ? String(point.cf_colo).slice(0, 32) : null,
  };
}

function mergeDay(existing, targetId, day, incoming, env) {
  const byBucket = new Map();
  const oldPoints = Array.isArray(existing?.points) ? existing.points : [];
  for (const point of oldPoints) {
    const normalized = normalizeProbePoint(point);
    if (normalized && dayFromSec(normalized.checked_at, env) === day) byBucket.set(normalized.checked_at, normalized);
  }
  for (const point of incoming || []) {
    const normalized = normalizeProbePoint(point);
    if (normalized && dayFromSec(normalized.checked_at, env) === day) byBucket.set(normalized.checked_at, normalized);
  }
  const maxPoints = clamp(Number(env.PROBE_HISTORY_MAX_POINTS_PER_DAY || DEFAULT_MAX_POINTS), 288, 10_000);
  const points = [...byBucket.values()].sort((a, b) => a.checked_at - b.checked_at).slice(-maxPoints);
  return { schema: SCHEMA, target_id: String(targetId || existing?.target_id || ''), day, points };
}

function toPublicPoint(point) {
  const missed = isMissedMonitorPoint({ ...point, error: point?.error ?? point?.last_error }) || (Number(point?.total || 0) === 0 && Number(point?.ok_count || 0) === 0);
  return {
    missed,
    checked_at: Number(point.checked_at),
    ok: missed ? 0 : Number(point.last_ok || 0),
    latency_ms: missed ? null : (point.last_latency_ms == null ? null : Number(point.last_latency_ms)),
    status_code: missed ? null : (point.last_status_code == null ? null : Number(point.last_status_code)),
    error: point.last_error == null ? null : String(point.last_error),
    probe_region: point.probe_region || 'auto',
    total: missed ? Math.max(1, Number(point.total || 0) || 1) : Number(point.total || 0),
    ok_count: missed ? 0 : Number(point.ok_count || 0),
    bucket: true,
  };
}

function summarizePoints(points) {
  let total = 0;
  let okCount = 0;
  let sumLatency = 0;
  for (const point of points || []) {
    if (isMissedMonitorPoint(point)) continue;
    total += Math.max(0, Number(point.total || 0));
    okCount += Math.max(0, Number(point.ok_count || 0));
    const latency = Number(point.latency_ms);
    if (okCount && Number.isFinite(latency)) sumLatency += latency * Math.max(0, Number(point.ok_count || 0));
  }
  return { total, ok_count: okCount, sum_latency_ms: sumLatency };
}

function boundedDayRange(fromDay, toDay, env, since, until) {
  const start = isDay(fromDay) ? fromDay : dayFromSec(since || nowSec(), env);
  const end = isDay(toDay) ? toDay : dayFromSec(until || nowSec(), env);
  const out = [];
  let day = start;
  for (let i = 0; i < DAY_RANGE_LIMIT && day <= end; i += 1) {
    out.push(day);
    day = addDays(day, 1);
  }
  return out;
}

function addDays(day, offset) {
  const value = new Date(`${String(day).slice(0, 10)}T00:00:00.000Z`);
  if (!Number.isFinite(value.getTime())) return String(day).slice(0, 10);
  value.setUTCDate(value.getUTCDate() + Number(offset || 0));
  return value.toISOString().slice(0, 10);
}

function isDay(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
}
