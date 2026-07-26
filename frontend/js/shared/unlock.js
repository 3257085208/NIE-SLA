export function unlockState(service) {
  const status = String(service?.status || '').trim().toLowerCase();
  const method = String(service?.method || '').trim().toLowerCase();
  if (/失败|未解锁|不支持|封锁|屏蔽|禁止|禁会员/.test(status) || /(?:^|\s)(?:blocked|failed|no|unsupported|restricted)(?:\s|$)/.test(status)) return 'bad';
  if (/dns/.test(status) || /dns/.test(method)) return 'dns';
  if (/仅\s*app|部分|partial/.test(status)) return 'dns';
  if (/解锁|原生|unlocked|native|yes|ok/.test(status)) return 'good';
  return 'unknown';
}
