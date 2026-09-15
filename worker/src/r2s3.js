import { clamp } from './utils.js';

const cache = new WeakMap();
const ALGO = 'AWS4-HMAC-SHA256';
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_TIMEOUT_MS = 60_000;

function awsEncode(value) {
  return encodeURIComponent(String(value ?? ''))
    .replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

function canonicalQuery(query = {}) {
  const pairs = Object.entries(query).map(([key, value]) => [awsEncode(key), awsEncode(value)]);
  pairs.sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));
  return pairs.map(([key, value]) => `${key}=${value}`).join('&');
}

function canonicalHeaderValue(value) {
  return String(value ?? '').trim().replace(/\s+/g, ' ');
}

function decodeXml(value) {
  return String(value || '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&#x2F;/gi, '/').replace(/&#x27;/gi, "'").replace(/&amp;/g, '&');
}

function byteLength(value, encoder) {
  if (typeof value === 'string') return encoder.encode(value).byteLength;
  if (value instanceof ArrayBuffer) return value.byteLength;
  if (ArrayBuffer.isView(value)) return value.byteLength;
  return Number(value?.size) || 0;
}

async function responseError(operation, response) {
  let detail = '';
  try { detail = (await response.text()).replace(/\s+/g, ' ').trim().slice(0, 240); } catch (_) {}
  return new Error(`S3 ${operation} failed (${response.status})${detail ? `: ${detail}` : ''}`);
}

export function withS3Archive(env) {
  if (!env || !env.ARCHIVE) return env;
  const accessKey = String(env.R2_S3_ACCESS_KEY_ID || '').trim();
  const secretKey = String(env.R2_S3_SECRET_ACCESS_KEY || '').trim();
  const accountId = String(env.R2_S3_ACCOUNT_ID || '').trim();
  if (!accessKey || !secretKey || !accountId) return env;
  const memo = cache.get(env);
  if (memo) return memo;
  const wrapped = { ...env, ARCHIVE: createS3ArchiveFacade({ ...env, R2_S3_ACCESS_KEY_ID: accessKey, R2_S3_SECRET_ACCESS_KEY: secretKey, R2_S3_ACCOUNT_ID: accountId }) };
  cache.set(env, wrapped);
  return wrapped;
}

export function createS3ArchiveFacade(env) {
  const host = `${String(env.R2_S3_ACCOUNT_ID).trim()}.r2.cloudflarestorage.com`;
  const bucket = String(env.R2_S3_BUCKET || 'nie-sla-archive').replace(/^\/+|\/+$/g, '');
  const accessKey = String(env.R2_S3_ACCESS_KEY_ID || '').trim();
  const secretKey = String(env.R2_S3_SECRET_ACCESS_KEY || '').trim();
  const region = 'auto';
  const encoder = new TextEncoder();
  const timeoutMs = clamp(Number(env.R2_S3_TIMEOUT_MS || DEFAULT_TIMEOUT_MS), 100, MAX_TIMEOUT_MS);

  async function hmacRaw(key, value) {
    const cryptoKey = await crypto.subtle.importKey('raw', typeof key === 'string' ? encoder.encode(key) : key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(value)));
  }

  async function sha256Hex(data) {
    const digest = await crypto.subtle.digest('SHA-256', typeof data === 'string' ? encoder.encode(data) : data);
    return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
  }

  function uriFor(key) {
    const path = String(key || '').replace(/^\/+/, '');
    return `/${awsEncode(bucket)}${path ? `/${path.split('/').map(awsEncode).join('/')}` : ''}`;
  }

  async function request(method, key, { query = {}, body = null, contentType = null, customMetadata = {} } = {}) {
    const now = new Date();
    const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    const date = amzDate.slice(0, 8);
    const payloadHash = 'UNSIGNED-PAYLOAD';
    const canonicalUri = uriFor(key);
    const sortedQuery = canonicalQuery(query);
    const requestHeaders = {
      host,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
    };
    if (contentType) requestHeaders['content-type'] = contentType;
    for (const [name, value] of Object.entries(customMetadata || {})) {
      const cleanName = String(name || '').trim().toLowerCase();
      if (!/^[a-z0-9._-]{1,64}$/.test(cleanName) || value == null) continue;
      requestHeaders[`x-amz-meta-${cleanName}`] = String(value).replace(/[\r\n]/g, ' ').slice(0, 2048);
    }
    const canonicalHeaderEntries = Object.entries(requestHeaders)
      .map(([name, value]) => [name.toLowerCase(), canonicalHeaderValue(value)])
      .sort((a, b) => a[0].localeCompare(b[0]));
    const canonicalHeaders = `${canonicalHeaderEntries.map(([name, value]) => `${name}:${value}`).join('\n')}\n`;
    const signedHeaders = canonicalHeaderEntries.map(([name]) => name).join(';');
    const canonicalRequest = [method, canonicalUri, sortedQuery, canonicalHeaders, signedHeaders, payloadHash].join('\n');
    const scope = `${date}/${region}/s3/aws4_request`;
    const stringToSign = [ALGO, amzDate, scope, await sha256Hex(canonicalRequest)].join('\n');
    const kDate = await hmacRaw(`AWS4${secretKey}`, date);
    const kRegion = await hmacRaw(kDate, region);
    const kService = await hmacRaw(kRegion, 's3');
    const kSigning = await hmacRaw(kService, 'aws4_request');
    const cryptoKey = await crypto.subtle.importKey('raw', kSigning, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const signature = [...new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(stringToSign)))].map(b => b.toString(16).padStart(2, '0')).join('');
    const authorization = `${ALGO} Credential=${accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
    const headers = { ...requestHeaders, authorization };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(`${endpoint()}${canonicalUri}${sortedQuery ? `?${sortedQuery}` : ''}`, {
        method,
        headers,
        body: method === 'GET' || method === 'HEAD' ? undefined : body,
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) throw new Error(`S3 ${method} ${key || '/'} timed out after ${timeoutMs}ms`);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  function endpoint() { return `https://${host}`; }

  return {
    async put(key, body, opts = {}) {
      const contentType = opts?.httpMetadata?.contentType || 'application/octet-stream';
      const res = await request('PUT', key, { body, contentType, customMetadata: opts?.customMetadata });
      if (!res.ok) throw await responseError('put', res);
      const size = byteLength(body, encoder);
      return { size };
    },
    async get(key) {
      const res = await request('GET', key);
      if (res.status === 404) return null;
      if (!res.ok) throw await responseError('get', res);
      const text = await res.text();
      return { json: async () => JSON.parse(text), size: byteLength(text, encoder) };
    },
    async head(key) {
      const res = await request('HEAD', key);
      if (res.status === 404) return null;
      if (!res.ok) throw await responseError('head', res);
      const len = Number(res.headers.get('content-length') || 0);
      return { size: len };
    },
    async delete(keys) {
      const list = Array.isArray(keys) ? keys : [keys];
      for (const key of list) {
        const res = await request('DELETE', key);
        if (!res.ok && res.status !== 404) throw await responseError('delete', res);
      }
      return {};
    },
    async list({ prefix = '', cursor = undefined, limit = 1000 } = {}) {
      const query = { 'list-type': '2', prefix };
      if (cursor) query['continuation-token'] = cursor;
      query['max-keys'] = String(clamp(Number(limit) || 1000, 1, 1000));
      const res = await request('GET', '', { query });
      if (!res.ok) throw await responseError('list', res);
      const xml = await res.text();
      const objects = [...xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)].map(([, content]) => ({
        key: decodeXml(content.match(/<Key>([\s\S]*?)<\/Key>/)?.[1] || ''),
        size: Number(content.match(/<Size>(\d+)<\/Size>/)?.[1] || 0),
        last_modified: content.match(/<LastModified>([\s\S]*?)<\/LastModified>/)?.[1] || '',
      })).filter((object) => object.key);
      const truncated = /<IsTruncated>true<\/IsTruncated>/.test(xml);
      const token = xml.match(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/);
      return { objects, truncated, cursor: token ? decodeXml(token[1]) : undefined };
    },
  };
}
