import { ApiError } from './auth.js';

const COUNTRY_INDEX_URL = 'https://countriesnow.space/api/v0.1/countries/iso';
const CITY_INDEX_URL = 'https://countriesnow.space/api/v0.1/countries/cities/q';
const CACHE_ORIGIN = 'https://location-catalog.nie-sla.invalid';
const COUNTRY_CACHE_SEC = 7 * 86400;
const CITY_CACHE_SEC = 86400;
const MAX_UPSTREAM_CHARS = 2_000_000;

export function normalizeCityCatalog(input) {
  if (!Array.isArray(input)) return [];
  const seen = new Set();
  const cities = [];
  for (const entry of input) {
    const city = String(entry || '').trim().replace(/\s+/g, ' ').slice(0, 64);
    const key = city.toLocaleLowerCase('en');
    if (!city || seen.has(key)) continue;
    seen.add(key);
    cities.push(city);
  }
  return cities.sort((left, right) => left.localeCompare(right, 'zh-CN', { numeric: true, sensitivity: 'base' }));
}

export async function getCountryCities(countryCode, options = {}) {
  const code = String(countryCode || '').trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) throw new ApiError(400, '请选择有效的国家或地区');

  const cache = options.cache ?? globalThis.caches?.default;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const cityCacheKey = new Request(`${CACHE_ORIGIN}/cities?country=${code}`);
  const cached = await readCachedJson(cache, cityCacheKey);
  if (cached?.country_code === code && Array.isArray(cached.cities)) {
    return { ...cached, cached: true };
  }

  const countries = await getCountryIndex({ cache, fetchImpl });
  const countryName = String(countries[code] || '').trim();
  if (!countryName) throw new ApiError(404, '该国家或地区暂无城市目录');

  const url = new URL(CITY_INDEX_URL);
  url.searchParams.set('country', countryName);
  const upstream = await fetchCatalogJson(url, fetchImpl);
  const cities = normalizeCityCatalog(upstream?.data);
  if (upstream?.error !== false || !cities.length) throw new ApiError(502, '城市目录暂时不可用，请稍后重试');

  const payload = {
    ok: true,
    country_code: code,
    country_name: countryName,
    cities,
    updated_at: Math.floor(Date.now() / 1000),
  };
  await writeCachedJson(cache, cityCacheKey, payload, CITY_CACHE_SEC);
  return { ...payload, cached: false };
}

async function getCountryIndex({ cache, fetchImpl }) {
  const cacheKey = new Request(`${CACHE_ORIGIN}/countries`);
  const cached = await readCachedJson(cache, cacheKey);
  if (cached?.names && typeof cached.names === 'object') return cached.names;

  const upstream = await fetchCatalogJson(COUNTRY_INDEX_URL, fetchImpl);
  if (upstream?.error !== false || !Array.isArray(upstream.data)) {
    throw new ApiError(502, '国家目录暂时不可用，请稍后重试');
  }
  const names = {};
  for (const entry of upstream.data) {
    const code = String(entry?.Iso2 || '').trim().toUpperCase();
    const name = String(entry?.name || '').trim().slice(0, 96);
    if (/^[A-Z]{2}$/.test(code) && name) names[code] = name;
  }
  if (!Object.keys(names).length) throw new ApiError(502, '国家目录暂时不可用，请稍后重试');
  await writeCachedJson(cache, cacheKey, { names }, COUNTRY_CACHE_SEC);
  return names;
}

async function fetchCatalogJson(url, fetchImpl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort('location-catalog-timeout'), 8000);
  try {
    const response = await fetchImpl(String(url), {
      headers: { accept: 'application/json', 'user-agent': 'NIE-SLA/1.0' },
      signal: controller.signal,
    });
    if (!response?.ok) throw new ApiError(502, '位置目录服务暂时不可用');
    const text = await response.text();
    if (text.length > MAX_UPSTREAM_CHARS) throw new ApiError(502, '位置目录返回内容过大');
    try { return JSON.parse(text); }
    catch (_) { throw new ApiError(502, '位置目录返回格式无效'); }
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(502, '位置目录服务连接失败，请稍后重试');
  } finally {
    clearTimeout(timer);
  }
}

async function readCachedJson(cache, key) {
  if (!cache?.match) return null;
  try {
    const response = await cache.match(key);
    return response ? await response.json() : null;
  } catch (_) { return null; }
}

async function writeCachedJson(cache, key, value, maxAge) {
  if (!cache?.put) return;
  const response = Response.json(value, {
    headers: { 'cache-control': `public, max-age=${maxAge}`, 'content-type': 'application/json; charset=utf-8' },
  });
  await cache.put(key, response).catch(() => {});
}
