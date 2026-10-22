export class ApiResponseError extends Error {
  constructor(message, { status = 0, retryAfterSec = 0 } = {}) {
    super(message);
    this.name = 'ApiResponseError';
    this.status = Number(status) || 0;
    this.retryAfterSec = Math.max(0, Number(retryAfterSec) || 0);
  }
}

export function retryAfterSeconds(response) {
  const value = String(response?.headers?.get?.('retry-after') || '').trim();
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds > 0) return Math.ceil(seconds);
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(1, Math.ceil((at - Date.now()) / 1000)) : 0;
}

export function nonJsonResponseMessage(response, text = '', fallback = '接口请求失败') {
  const status = Number(response?.status || 0);
  const contentType = String(response?.headers?.get?.('content-type') || '').toLowerCase();
  const body = String(text || '');
  const looksHtml = contentType.includes('text/html')
    || contentType.includes('application/xhtml')
    || /^\s*<!doctype\s+html|^\s*<html[\s>]/i.test(body);
  const cloudflareLimited = status === 429
    || /error\s*10(?:15|27)|rate limited|just a moment|attention required|cloudflare ray id/i.test(body);
  if (cloudflareLimited) return 'Cloudflare 免费额度、限流或安全策略已触发，请稍后重试';
  if (status >= 500) return `上游服务暂时不可用（HTTP ${status}），请稍后重试`;
  if (looksHtml) return `服务返回了 HTML 错误页（HTTP ${status || '未知'}），请稍后重试`;
  return status ? `${fallback}（HTTP ${status}）` : fallback;
}

export async function readJsonResponse(response, fallback = '接口请求失败') {
  const contentType = String(response?.headers?.get?.('content-type') || '').toLowerCase();
  if (contentType.includes('json')) {
    try {
      return await response.json();
    } catch (_) {}
  }
  const text = contentType.includes('json') ? '' : await response.text().catch(() => '');
  try {
    return text ? JSON.parse(text) : {};
  } catch (_) {
    throw new ApiResponseError(nonJsonResponseMessage(response, text, fallback), {
      status: response.status,
      retryAfterSec: retryAfterSeconds(response),
    });
  }
}
