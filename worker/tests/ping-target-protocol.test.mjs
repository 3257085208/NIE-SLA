import assert from 'node:assert/strict';
import { normalizePingTarget, normalizeProbeProtocols, pingTargetProtocol } from '../src/ping-target-protocol.js';

assert.deepEqual(normalizePingTarget('example.com:443'), { target: 'example.com:443', protocol: 'tcp' });
assert.deepEqual(normalizePingTarget('[2001:db8::1]:443'), { target: '[2001:db8::1]:443', protocol: 'tcp' });
assert.deepEqual(normalizePingTarget('tcp://example.com:443'), { target: 'tcp://example.com:443', protocol: 'tcp' });
assert.deepEqual(normalizePingTarget('TCP://example.com:443'), { target: 'tcp://example.com:443', protocol: 'tcp' });
assert.deepEqual(normalizePingTarget('https://example.com/health'), { target: 'https://example.com/health', protocol: 'http' });
assert.equal(pingTargetProtocol('icmp://example.com'), 'icmp', 'legacy ICMP rows must remain identifiable for filtering and deletion');
assert.deepEqual(normalizeProbeProtocols('icmp,tcp,http,unknown'), ['tcp', 'http']);

for (const invalid of [
  'example.com',
  'example.com:0',
  'example.com:65536',
  'https://user:pass@example.com/',
  'icmp://example.com',
  'ICMP://[2001:db8::1]',
  'icmp://example.com/path',
  'icmp://example.com:7',
  'tcp://example.com',
]) {
  assert.throws(() => normalizePingTarget(invalid), /Ping|目标|HTTP|ICMP|TCP|不再支持/);
}

console.log('Ping target protocol tests passed');
