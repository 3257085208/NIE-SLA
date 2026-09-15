import assert from 'node:assert/strict';
import { parseProxyLinks, proxyLinkPreview } from '../src/admin/proxy-links.js';

const uuid = '8c7f969f-0000-4000-8000-000000000001';
const vmess = `vmess://${Buffer.from(JSON.stringify({
  v: '2', ps: 'VMess demo', add: 'vmess.example.test', port: '443', id: uuid,
  aid: '0', scy: 'auto', net: 'ws', host: 'vmess.example.test', path: '/ws', tls: 'tls',
})).toString('base64')}`;
const ssMethodPassword = Buffer.from('aes-256-gcm:secret').toString('base64');
const ssFull = `ss://${Buffer.from('aes-256-gcm:secret@ss.example.test:8388').toString('base64')}#SS%20demo`;

const parsed = parseProxyLinks([
  `vless://${uuid}@vless.example.test:443?type=grpc&security=tls&serviceName=edge&sni=edge.example.test#VLESS`,
  vmess,
  `ss://${ssMethodPassword}@ss.example.test:8388#SS%20demo`,
  ssFull,
  'trojan://trojan-secret@trojan.example.test:443?security=tls#Trojan',
  'hysteria2://hy2-secret@hy2.example.test:443?sni=hy2.example.test#H2',
  'snell://snell-secret@snell.example.test:443?version=v4&obfs=tls&obfs-host=cdn.example.test#Snell',
  'anytls://anytls-secret@anytls.example.test:443?sni=anytls.example.test#AnyTLS',
  'tuic://00000000-0000-4000-8000-000000000000:tuic-secret@tuic.example.test:443?congestion_control=bbr#TUIC',
].join('\n'));

assert.equal(parsed.length, 9);
assert.equal(parsed[0].transport, 'tls-grpc');
assert.equal(parsed[0].secret.grpc_service_name, 'edge');
assert.equal(parsed[1].protocol, 'vmess');
assert.equal(parsed[2].secret.cipher, 'aes-256-gcm');
assert.equal(parsed[3].server, 'ss.example.test');
assert.equal(parsed[4].secret.password, 'trojan-secret');
assert.equal(parsed[5].transport, 'quic');
assert.equal(parsed[6].secret.obfs, 'tls');
assert.equal(parsed[7].runtime_supported, true);
assert.equal(parsed[8].runtime_supported, false);
assert.equal('secret' in proxyLinkPreview(parsed[0]), false, 'preview must not expose credentials');

const subscription = Buffer.from([
  `socks5://user:pass@socks.example.test:1080#SOCKS`,
  `http://http.example.test:8080#HTTP`,
].join('\n')).toString('base64url');
assert.deepEqual(parseProxyLinks(subscription).map(item => item.protocol), ['socks5', 'http']);

const clash = parseProxyLinks(`proxies:\n  - name: Clash SS\n    type: ss\n    server: clash.example.test\n    port: 8388\n    cipher: aes-256-gcm\n    password: secret`);
assert.equal(clash[0].protocol, 'ss');
assert.equal(clash[0].server, 'clash.example.test');

assert.throws(() => parseProxyLinks('not a proxy link'), /可识别/);
assert.throws(() => parseProxyLinks('vless://\u0000bad'), /控制字符/);

console.log('proxy link parser and credential redaction passed');
