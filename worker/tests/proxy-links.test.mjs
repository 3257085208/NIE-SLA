import assert from 'node:assert/strict';
import { parseProxyLinks, proxyLinkPreview } from '../src/admin/proxy-links.js';

const uuid = '8c7f969f-0000-4000-8000-000000000001';
const realityPublicKey = Buffer.alloc(32, 0x42).toString('base64url');
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

const clashMixedText = `proxies:
  - name: VLESS Clash
    type: vless
    server: vless-clash.example.test
    port: 443
    uuid: ${uuid}
    network: ws
    tls: true
    servername: sni-clash.example.test
    skip-cert-verify: true
    ws-opts:
      path: /proxy
      headers:
        Host: cdn-clash.example.test
    alpn: [h2, http/1.1]
  - name: VMess Clash
    type: vmess
    server: vmess-clash.example.test
    port: 443
    uuid: ${uuid}
    alterId: 0
    cipher: auto
    network: grpc
    tls: true
    grpc-opts:
      grpc-service-name: edge-service`;
const clashMixed = parseProxyLinks(clashMixedText);
assert.equal(clashMixed.length, 2);
assert.equal(clashMixed[0].transport, 'tls-ws');
assert.equal(clashMixed[0].sni, 'sni-clash.example.test');
assert.equal(clashMixed[0].ws_host, 'cdn-clash.example.test');
assert.equal(clashMixed[0].secret.alpn, 'h2,http/1.1');
assert.equal(clashMixed[0].secret.skip_cert_verify, true);
assert.equal(clashMixed[1].transport, 'tls-grpc');
assert.equal(clashMixed[1].secret.grpc_service_name, 'edge-service');
assert.equal(clashMixed[1].runtime_supported, true);

const encodedClash = Buffer.from(clashMixedText).toString('base64url');
assert.deepEqual(parseProxyLinks(encodedClash).map(item => item.name), ['VLESS Clash', 'VMess Clash']);

const singBox = parseProxyLinks(JSON.stringify({ outbounds: [{
  type: 'vless', tag: 'ignored tag', server: 'singbox.example.test', server_port: 443, uuid,
  tls: { enabled: true, server_name: 'singbox.sni.test', insecure: true },
  transport: { type: 'ws', path: '/singbox', headers: { Host: 'singbox.host.test' } },
}] }));
assert.equal(singBox.length, 1);
assert.equal(singBox[0].name, 'vless');
assert.equal(singBox[0].transport, 'tls-ws');
assert.equal(singBox[0].sni, 'singbox.sni.test');
assert.equal(singBox[0].ws_host, 'singbox.host.test');
assert.equal(singBox[0].secret.skip_cert_verify, true);

const reality = parseProxyLinks(`vless://${uuid}@reality.example.test:443?security=reality&type=tcp#Reality`)[0];
assert.equal(reality.runtime_supported, false);
assert.match(reality.runtime_reason, /Reality/);
const supportedReality = parseProxyLinks(`vless://${uuid}@reality.example.test:443?security=reality&type=tcp&pbk=${realityPublicKey}&sid=0a0b&fp=chrome#Reality%20supported`)[0];
assert.equal(supportedReality.runtime_supported, true);
assert.equal(supportedReality.secret.reality_public_key, realityPublicKey);
assert.equal(supportedReality.secret.reality_short_id, '0a0b');
const clashReality = parseProxyLinks(`proxies:
  - name: Clash Reality
    type: vless
    server: reality-clash.example.test
    port: 443
    uuid: ${uuid}
    network: tcp
    tls: true
    servername: reality-clash.example.test
    flow: xtls-rprx-vision
    reality-opts:
      public-key: ${realityPublicKey}
      short-id: 0a0b`)[0];
assert.equal(clashReality.runtime_supported, true);
assert.equal(clashReality.secret.reality_public_key, realityPublicKey);
assert.equal(clashReality.secret.reality_short_id, '0a0b');
const singBoxReality = parseProxyLinks(JSON.stringify({ outbounds: [{
  type: 'vless', server: 'singbox-reality.example.test', server_port: 443, uuid,
  tls: { enabled: true, server_name: 'singbox-reality.example.test', reality: { public_key: realityPublicKey, short_id: '0a0b' } },
}] }))[0];
assert.equal(singBoxReality.runtime_supported, true);
assert.equal(singBoxReality.secret.reality_public_key, realityPublicKey);
assert.equal(singBoxReality.secret.reality_short_id, '0a0b');
const legacyVmess = parseProxyLinks(`vmess://${Buffer.from(JSON.stringify({ add: 'legacy-vmess.example.test', port: 443, id: uuid, aid: 1, net: 'tcp' })).toString('base64')}`)[0];
assert.equal(legacyVmess.runtime_supported, false);
assert.match(legacyVmess.runtime_reason, /alter_id/);

assert.throws(() => parseProxyLinks('not a proxy link'), /可识别/);
assert.throws(() => parseProxyLinks('vless://\u0000bad'), /控制字符/);
assert.throws(() => parseProxyLinks('clash://install-config?url=https%3A%2F%2Fsub.example.test'), /不自动抓取/);

console.log('proxy link parser and credential redaction passed');
