const API_BASE_KEYS = ['NSTATUS_API_BASE', 'API_BASE', 'WORKER_URL'];

function getApiBase(env) {
  for (const key of API_BASE_KEYS) {
    const value = String(env?.[key] || '').trim().replace(/\/+$/, '');
    if (value) return value;
  }
  return '';
}

function withCors(response, request) {
  const headers = new Headers(response.headers);
  const origin = request.headers.get('Origin');
  if (origin && origin === new URL(request.url).origin) headers.set('Access-Control-Allow-Origin', origin);
  else headers.delete('Access-Control-Allow-Origin');
  headers.set('Vary', 'Origin');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export async function onRequestOptions({ request }) {
  const headers = new Headers();
  const origin = request.headers.get('Origin');
  if (origin && origin === new URL(request.url).origin) headers.set('Access-Control-Allow-Origin', origin);
  headers.set('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  headers.set('Access-Control-Allow-Headers', 'Authorization,Content-Type,x-admin-session,x-theme-sha256');
  headers.set('Access-Control-Max-Age', '86400');
  headers.set('Vary', 'Origin');
  return new Response(null, { status: 204, headers });
}

export async function onRequest(context) {
  const apiBase = getApiBase(context.env);
  if (!apiBase) {
    return Response.json({
      ok: false,
      error: 'Pages API proxy is missing NSTATUS_API_BASE',
    }, { status: 500 });
  }

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
    const response = await fetch(proxiedRequest);
    return withCors(response, context.request);
  } catch (err) {
    return withCors(Response.json({
      ok: false,
      error: 'Pages API proxy upstream request failed',
      detail: String(err?.message || err),
    }, { status: 502 }), context.request);
  }
}
