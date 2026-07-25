import assert from 'node:assert/strict';
import { getCountryCities, normalizeCityCatalog } from '../src/location-catalog.js';

assert.deepEqual(normalizeCityCatalog(['Tokyo', ' tokyo ', 'Kyoto', '', null, 'A'.repeat(80)]), [
  'A'.repeat(64),
  'Kyoto',
  'Tokyo',
]);

const responses = new Map();
const cache = {
  async match(request) { return responses.get(request.url)?.clone() || null; },
  async put(request, response) { responses.set(request.url, response.clone()); },
};
let fetchCount = 0;
const fetchImpl = async (url) => {
  fetchCount += 1;
  const payload = url.includes('/countries/iso')
    ? { error: false, data: [{ name: 'Japan', Iso2: 'JP' }] }
    : { error: false, data: ['Tokyo', 'Kyoto', ' Tokyo '] };
  return Response.json(payload);
};

const fresh = await getCountryCities('jp', { cache, fetchImpl });
assert.equal(fresh.country_code, 'JP');
assert.equal(fresh.country_name, 'Japan');
assert.deepEqual(fresh.cities, ['Kyoto', 'Tokyo']);
assert.equal(fresh.cached, false);
assert.equal(fetchCount, 2);

const cached = await getCountryCities('JP', { cache, fetchImpl });
assert.deepEqual(cached.cities, ['Kyoto', 'Tokyo']);
assert.equal(cached.cached, true);
assert.equal(fetchCount, 2);

await assert.rejects(() => getCountryCities('JPN', { cache, fetchImpl }), (error) => error?.status === 400);
await assert.rejects(() => getCountryCities('US', { cache, fetchImpl }), (error) => error?.status === 404);

console.log('location catalog tests passed');
