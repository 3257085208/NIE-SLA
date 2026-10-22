import assert from 'node:assert/strict';
import { ApiResponseError, nonJsonResponseMessage, readJsonResponse } from '../js/shared/api-response.js';

{
  const response = Response.json({ ok: true, value: 1 });
  assert.deepEqual(await readJsonResponse(response), { ok: true, value: 1 });
}

{
  const html = '<!DOCTYPE html><html><head><title>Error 1027</title></head><body>rate limited</body></html>';
  const response = new Response(html, {
    status: 429,
    headers: { 'content-type': 'text/html', 'retry-after': '300' },
  });
  await assert.rejects(
    () => readJsonResponse(response, 'Ping 数据加载失败'),
    (error) => error instanceof ApiResponseError
      && error.status === 429
      && error.retryAfterSec === 300
      && /免费额度、限流或安全策略/.test(error.message)
      && !/DOCTYPE|html body/i.test(error.message),
  );
}

{
  const response = new Response('<html><body>origin unavailable</body></html>', {
    status: 503,
    headers: { 'content-type': 'text/html' },
  });
  await assert.rejects(
    () => readJsonResponse(response),
    /上游服务暂时不可用（HTTP 503）/,
  );
}

{
  const response = new Response('<html><body>challenge</body></html>', {
    status: 403,
    headers: { 'content-type': 'text/html' },
  });
  assert.match(nonJsonResponseMessage(response, '<html><body>challenge</body></html>'), /HTML 错误页（HTTP 403）/);
}

console.log('API response error boundary tests passed');
