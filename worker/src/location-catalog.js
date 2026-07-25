import { ApiError } from './auth.js';

const CHINESE_CITY_INDEX_URL = 'https://raw.githubusercontent.com/ufLearn/GlobalCityData/d7e2f7c8378bd46385e3dc2ce638eac97d66b00c/data_region.json';
const CHINA_AREA_URL = 'https://unpkg.com/china-area-data@5.0.1/data.json';
const CACHE_ORIGIN = 'https://location-catalog.nie-sla.invalid';
const CACHE_SCHEMA = 'zh-v1';
const GLOBAL_CATALOG_CACHE_SEC = 7 * 86400;
const CITY_CACHE_SEC = 86400;
const MAX_UPSTREAM_CHARS = 2_000_000;

const COUNTRY_CATALOG_ALIASES = {
  AG: 'Antigua and Barbuda',
  AX: 'Aland lslands',
  BA: 'Bosnia and Herzegovina',
  BY: 'White Russia',
  CD: 'Congo(DRC)',
  CG: 'Congo',
  CW: 'Curacao',
  CZ: 'Czech Republic',
  FJ: 'Fiji Islands',
  GS: 'South Georgia and South Sandwich Islands',
  HM: 'Heard Island and McDonald Islands',
  KR: 'Korea',
  MK: 'Macedonia,Former Yugoslav Republic of',
  MM: 'Myanmar',
  PF: 'Frech Polynesia',
  PS: 'Palestinian Authority',
  PN: 'Pitcairn Islands',
  RE: 'Reunion',
  SJ: 'Svalbard and Jan Mayen',
  ST: 'Sao Tome and Principe',
  SZ: 'Swaziland',
  TC: 'Turks and Caicos Islands',
  TF: 'French Southern and Antarctic Lands',
  TR: 'Turkey',
  TT: 'Trinidad and Tobago',
  VA: 'Vatican City',
  VG: 'Virgin Islands,British',
  VI: 'Virgin Islands',
  WF: 'Wallis and Futuna',
};

const SINGLE_CITY_CATALOGS = {
  GQ: ['赤道几内亚'],
  GS: ['南乔治亚和南桑威奇群岛'],
  HK: ['香港'],
  KN: ['圣基茨和尼维斯'],
  LC: ['圣卢西亚'],
  ME: ['黑山'],
  MO: ['澳门'],
  PM: ['圣皮埃尔和密克隆'],
  RS: ['塞尔维亚'],
  TW: ['台湾'],
  VC: ['圣文森特和格林纳丁斯'],
};

const CHINA_MUNICIPALITIES = new Set(['110000', '120000', '310000', '500000']);
const CHINA_SEPARATE_REGIONS = new Set(['710000', '810000', '820000']);
const GENERIC_CHINA_AREAS = new Set(['省直辖县级行政区划', '自治区直辖县级行政区划']);

export function normalizeCityCatalog(input) {
  if (!Array.isArray(input)) return [];
  const seen = new Set();
  const cities = [];
  for (const entry of input) {
    const city = String(entry || '').trim().replace(/\s+/g, ' ').slice(0, 64);
    const key = city.toLocaleLowerCase('zh-CN');
    if (!city || seen.has(key)) continue;
    seen.add(key);
    cities.push(city);
  }
  return cities.sort((left, right) => left.localeCompare(right, 'zh-CN', { numeric: true, sensitivity: 'base' }));
}

export function parseChinaCityCatalog(input) {
  const provinces = input?.['86'];
  if (!provinces || typeof provinces !== 'object') return [];
  const cities = [];
  for (const [provinceCode, provinceName] of Object.entries(provinces)) {
    if (CHINA_SEPARATE_REGIONS.has(provinceCode)) continue;
    if (CHINA_MUNICIPALITIES.has(provinceCode)) {
      cities.push(provinceName);
      continue;
    }
    const provinceCities = input?.[provinceCode];
    if (!provinceCities || typeof provinceCities !== 'object') continue;
    for (const cityName of Object.values(provinceCities)) {
      if (!GENERIC_CHINA_AREAS.has(cityName)) cities.push(cityName);
    }
  }
  return normalizeCityCatalog(cities);
}

export function parseChineseCityCatalog(input, countryCode, countryName = '') {
  const code = String(countryCode || '').trim().toUpperCase();
  if (SINGLE_CITY_CATALOGS[code]) return {
    countryName: SINGLE_CITY_CATALOGS[code][0],
    cities: [...SINGLE_CITY_CATALOGS[code]],
  };
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { countryName: '', cities: [] };

  const expectedName = COUNTRY_CATALOG_ALIASES[code] || countryName;
  const expectedKey = normalizeCatalogKey(expectedName);
  const match = Object.entries(input).find(([key, value]) =>
    normalizeCatalogKey(key) === expectedKey || normalizeCatalogKey(value?.label_en) === expectedKey);
  if (!match) return { countryName: '', cities: [] };

  const record = match[1] || {};
  const countryLabel = String(record.label || record.value || '').trim().slice(0, 64);
  const cities = [];
  for (const region of Array.isArray(record.children) ? record.children : []) {
    const nested = Array.isArray(region?.children) ? region.children : [];
    if (nested.length) cities.push(...nested);
    else cities.push(region?.label || region?.value);
  }
  if (!cities.length && countryLabel) cities.push(countryLabel);
  return { countryName: countryLabel, cities: normalizeCityCatalog(cities) };
}

export async function getCountryCities(countryCode, options = {}) {
  const code = String(countryCode || '').trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) throw new ApiError(400, '请选择有效的国家或地区');

  const cache = options.cache ?? globalThis.caches?.default;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const cityCacheKey = new Request(`${CACHE_ORIGIN}/${CACHE_SCHEMA}/cities?country=${code}`);
  const cached = await readCachedJson(cache, cityCacheKey);
  if (cached?.country_code === code && Array.isArray(cached.cities)) {
    return { ...cached, cached: true };
  }

  let countryName;
  let cities;
  let source;
  if (code === 'CN') {
    const upstream = await fetchCatalogJson(CHINA_AREA_URL, fetchImpl);
    countryName = '中国';
    cities = parseChinaCityCatalog(upstream);
    source = 'china-area-data';
  } else if (SINGLE_CITY_CATALOGS[code]) {
    ({ countryName, cities } = parseChineseCityCatalog(null, code));
    source = 'global-city-data';
  } else {
    const upstreamCountryName = regionDisplayName(code, 'en');
    const upstream = await getChineseCityIndex({ cache, fetchImpl });
    ({ countryName, cities } = parseChineseCityCatalog(upstream, code, upstreamCountryName));
    if (!countryName || !cities.length) {
      countryName = regionDisplayName(code, 'zh-CN');
      cities = countryName ? [countryName] : [];
    }
    source = 'global-city-data';
  }
  if (!countryName || !cities.length) throw new ApiError(404, '该国家或地区暂无中文城市目录');

  const payload = {
    ok: true,
    country_code: code,
    country_name: countryName,
    language: 'zh-CN',
    source,
    cities,
    updated_at: Math.floor(Date.now() / 1000),
  };
  await writeCachedJson(cache, cityCacheKey, payload, CITY_CACHE_SEC);
  return { ...payload, cached: false };
}

function normalizeCatalogKey(value) {
  return String(value || '').normalize('NFKD').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function regionDisplayName(code, locale) {
  try {
    const name = new Intl.DisplayNames([locale], { type: 'region' }).of(code);
    return name && name !== code ? String(name).trim().slice(0, 96) : '';
  } catch (_) {
    return '';
  }
}

async function getChineseCityIndex({ cache, fetchImpl }) {
  const cacheKey = new Request(`${CACHE_ORIGIN}/${CACHE_SCHEMA}/global-city-index`);
  const cached = await readCachedJson(cache, cacheKey);
  if (cached && typeof cached === 'object' && !Array.isArray(cached)) return cached;
  const upstream = await fetchCatalogJson(CHINESE_CITY_INDEX_URL, fetchImpl);
  if (!upstream || typeof upstream !== 'object' || Array.isArray(upstream)) {
    throw new ApiError(502, '中文城市目录返回格式无效');
  }
  await writeCachedJson(cache, cacheKey, upstream, GLOBAL_CATALOG_CACHE_SEC);
  return upstream;
}

async function fetchCatalogJson(url, fetchImpl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort('location-catalog-timeout'), 8000);
  try {
    const response = await fetchImpl(String(url), {
      headers: { accept: 'application/json', 'user-agent': 'NIE-SLA/0.23' },
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
