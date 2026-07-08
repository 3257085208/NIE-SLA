const API_BASE_KEYS = ['NSTATUS_API_BASE', 'API_BASE', 'WORKER_URL'];

function getApiBase(env) {
  for (const key of API_BASE_KEYS) {
    const value = String(env?.[key] || '').trim().replace(/\/+$/, '');
    if (value) return value;
  }
  return '';
}

export async function onRequest(context) {
  const apiBase = getApiBase(context.env);
  if (!apiBase) return Response.json({ ok: false, error: 'Pages admin proxy is missing NSTATUS_API_BASE' }, { status: 500 });

  const sourceUrl = new URL(context.request.url);
  const targetUrl = new URL(sourceUrl.pathname + sourceUrl.search, apiBase);
  const headers = new Headers(context.request.headers);
  headers.set('Host', targetUrl.host);

  const proxiedRequest = new Request(targetUrl, {
    method: context.request.method,
    headers,
    body: ['GET', 'HEAD'].includes(context.request.method) ? undefined : context.request.body,
    redirect: 'manual',
  });

  try {
    return await fetch(proxiedRequest);
  } catch (err) {
    return Response.json({
      ok: false,
      error: 'Pages admin proxy upstream request failed',
      detail: String(err?.message || err),
    }, { status: 502 });
  }
}
