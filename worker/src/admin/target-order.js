export function normalizeTargetOrder(rawIds, existingIds, maxTargets = 500) {
  const requestedIds = Array.isArray(rawIds) ? rawIds.map(id => String(id || '').trim()).filter(Boolean) : [];
  if (!requestedIds.length || requestedIds.length > maxTargets) {
    return { ok: false, error: `排序列表不能为空，且最多支持 ${maxTargets} 个探针` };
  }
  if (new Set(requestedIds).size !== requestedIds.length) {
    return { ok: false, error: '排序列表中存在重复探针' };
  }

  const currentIds = (existingIds || []).map(id => String(id));
  const existingSet = new Set(currentIds);
  const unknown = requestedIds.filter(id => !existingSet.has(id));
  if (unknown.length) {
    return { ok: false, error: `排序列表包含不存在的探针：${unknown.slice(0, 3).join(', ')}` };
  }

  const requestedSet = new Set(requestedIds);
  return { ok: true, ids: [...requestedIds, ...currentIds.filter(id => !requestedSet.has(id))] };
}


// Manual rank edits ("Top ID" ordering): the target is moved to the requested
// position and everyone else shifts down one slot, producing a dense 1..N
// ranking exactly like a drag reorder. A rank beyond the list appends at the
// end. Dependency-free so it is directly unit-testable.
export async function applyTargetSortOrder(env, id, nextSortOrder) {
  const rows = await env.DB.prepare(`SELECT id FROM targets ORDER BY CASE WHEN sort_order IS NULL THEN 1 ELSE 0 END, sort_order, group_name COLLATE NOCASE, name COLLATE NOCASE`).all();
  const ids = (rows.results || []).map((row) => String(row.id));
  const targetId = String(id);
  const without = ids.filter((value) => value !== targetId);
  const index = Math.max(0, Math.min(without.length, Math.floor(Number(nextSortOrder)) - 1));
  without.splice(index, 0, targetId);
  for (let offset = 0; offset < without.length; offset += 50) {
    const batch = without.slice(offset, offset + 50).map((value, i) =>
      env.DB.prepare(`UPDATE targets SET sort_order = ? WHERE id = ?`).bind(offset + i, value));
    if (batch.length) await env.DB.batch(batch);
  }
}
