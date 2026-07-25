import assert from 'node:assert/strict';
import {
  getCountryCities,
  normalizeCityCatalog,
  parseChinaCityCatalog,
  parseChineseCityCatalog,
} from '../src/location-catalog.js';

assert.deepEqual(normalizeCityCatalog(['东京', ' 东京 ', '京都', '', null, '广州市', 'A'.repeat(80)]), [
  '东京',
  '广州市',
  '京都',
  'A'.repeat(64),
]);

const chinaAreas = {
  86: {
    110000: '北京市',
    310000: '上海市',
    440000: '广东省',
    510000: '四川省',
    650000: '新疆维吾尔自治区',
    710000: '台湾省',
  },
  110000: { 110100: '市辖区' },
  310000: { 310100: '市辖区' },
  440000: { 440100: '广州市', 440300: '深圳市' },
  510000: { 510100: '成都市', 513200: '阿坝藏族羌族自治州' },
  650000: { 650100: '乌鲁木齐市', 652900: '阿克苏地区', 659000: '自治区直辖县级行政区划' },
  710000: { 710100: '台北市' },
};
const chinaCities = parseChinaCityCatalog(chinaAreas);
for (const city of ['北京市', '上海市', '广州市', '深圳市', '成都市', '阿克苏地区', '阿坝藏族羌族自治州']) {
  assert.equal(chinaCities.includes(city), true, `${city} should be included`);
}
assert.equal(chinaCities.includes('市辖区'), false);
assert.equal(chinaCities.includes('自治区直辖县级行政区划'), false);
assert.equal(chinaCities.includes('台北市'), false);

const globalCatalog = {
  Japan: {
    label: '日本',
    label_en: 'Japan',
    children: [
      { label: '东京', children: [] },
      { label: '大阪', children: [] },
    ],
  },
  'United States': {
    label: '美国',
    label_en: 'United States',
    children: [
      { label: '加利福尼亚', children: ['洛杉矶', '旧金山'] },
      { label: '华盛顿', children: ['西雅图'] },
    ],
  },
  Singapore: { label: '新加坡', label_en: 'Singapore', children: [] },
};
assert.deepEqual(parseChineseCityCatalog(globalCatalog, 'JP', 'Japan'), {
  countryName: '日本',
  cities: ['大阪', '东京'],
});
assert.deepEqual(parseChineseCityCatalog(globalCatalog, 'US', 'United States'), {
  countryName: '美国',
  cities: ['旧金山', '洛杉矶', '西雅图'],
});
assert.deepEqual(parseChineseCityCatalog(globalCatalog, 'SG', 'Singapore'), {
  countryName: '新加坡',
  cities: ['新加坡'],
});
assert.deepEqual(parseChineseCityCatalog(null, 'HK'), { countryName: '香港', cities: ['香港'] });

function createCache() {
  const responses = new Map();
  return {
    responses,
    async match(request) { return responses.get(request.url)?.clone() || null; },
    async put(request, response) { responses.set(request.url, response.clone()); },
  };
}

const cache = createCache();
let fetchCount = 0;
const fetchImpl = async (url) => {
  fetchCount += 1;
  if (url.includes('GlobalCityData')) return Response.json(globalCatalog);
  throw new Error(`unexpected URL: ${url}`);
};

const fresh = await getCountryCities('jp', { cache, fetchImpl });
assert.equal(fresh.country_code, 'JP');
assert.equal(fresh.country_name, '日本');
assert.equal(fresh.language, 'zh-CN');
assert.deepEqual(fresh.cities, ['大阪', '东京']);
assert.equal(fresh.cached, false);
assert.equal(fetchCount, 1);

const cached = await getCountryCities('JP', { cache, fetchImpl });
assert.deepEqual(cached.cities, ['大阪', '东京']);
assert.equal(cached.cached, true);
assert.equal(fetchCount, 1);

const secondCountry = await getCountryCities('US', { cache, fetchImpl });
assert.deepEqual(secondCountry.cities, ['旧金山', '洛杉矶', '西雅图']);
assert.equal(fetchCount, 1, 'the shared global catalog should be reused across countries');

let chinaFetchCount = 0;
const chinaFresh = await getCountryCities('CN', {
  cache: createCache(),
  fetchImpl: async (url) => {
    chinaFetchCount += 1;
    assert.match(url, /china-area-data@5\.0\.1/);
    return Response.json(chinaAreas);
  },
});
assert.equal(chinaFresh.country_name, '中国');
assert.equal(chinaFresh.cities.includes('北京市'), true);
assert.equal(chinaFresh.cities.includes('阿克苏地区'), true);
assert.equal(chinaFetchCount, 1);

const hongKong = await getCountryCities('HK', {
  cache: createCache(),
  fetchImpl: async () => { throw new Error('single-city catalogs must not fetch'); },
});
assert.deepEqual(hongKong.cities, ['香港']);

await assert.rejects(() => getCountryCities('JPN', { cache, fetchImpl }), (error) => error?.status === 400);
const fallbackRegion = await getCountryCities('AQ', { cache: createCache(), fetchImpl });
assert.deepEqual(fallbackRegion.cities, ['南极洲']);
await assert.rejects(() => getCountryCities('CN', {
  cache: createCache(),
  fetchImpl: async () => new Response('x'.repeat(2_000_001)),
}), (error) => error?.status === 502 && /内容过大/.test(error.message));

console.log('location catalog tests passed');
