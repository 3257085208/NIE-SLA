import assert from 'node:assert/strict';
import { normalizePingTarget, normalizeProbeProtocols } from '../src/ping-target-protocol.js';

assert.deepEqual(normalizePingTarget('example.com:443'), { target: 'example.com:443', protocol: 'tcp' });
assert.deepEqual(normalizePingTarget('[2001:db8::1]:443'), { target: '[2001:db8::1]:443', protocol: 'tcp' });
assert.deepEqual(normalizePingTarget('tcp://example.com:443'), { target: 'tcp://example.com:443', protocol: 'tcp' });
assert.deepEqual(normalizePingTarget('TCP://example.com:443'), { target: 'tcp://example.com:443', protocol: 'tcp' });
assert.deepEqual(normalizePingTarget('https://example.com/health'), { target: 'https://example.com/health', protocol: 'http' });
assert.deepEqual(normalizePingTarget('icmp://example.com'), { target: 'icmp://example.com', protocol: 'icmp' });
assert.deepEqual(normalizePingTarget('ICMP://[2001:db8::1]'), { target: 'icmp://[2001:db8::1]', protocol: 'icmp' });
assert.deepEqual(normalizeProbeProtocols('icmp,tcp,unknown'), ['tcp', 'icmp']);

for (const invalid of [
  'example.com',
  'example.com:0',
  'example.com:65536',
  'https://user:pass@example.com/',
  'icmp://example.com/path',
  'icmp://example.com:7',
  'tcp://example.com',
]) {
  assert.throws(() => normalizePingTarget(invalid), /Ping|目标|HTTP|ICMP|TCP/);
}

console.log('Ping target protocol tests passed');
