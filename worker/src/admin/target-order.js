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
