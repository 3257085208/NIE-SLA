import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const cftz = path.join(root, 'agent', 'cftz');
const requests = [];
const server = http.createServer((request, response) => {
  requests.push({ url: request.url, headers: request.headers });
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end('{"ok":true}\n');
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
const base = `http://127.0.0.1:${address.port}`;

try {
  const script = [
    'set -euo pipefail',
    'set -- __source_only__',
    'source "$CFTZ_PATH" >/dev/null',
    'curl_agent_api "agent-secret" -fsS "$TEST_BASE/agent" >/dev/null',
    'curl_admin_api "session-secret" -fsS "$TEST_BASE/admin" >/dev/null',
  ].join('\n');
  const child = spawn('bash', ['-c', script], {
    env: { ...process.env, CFTZ_PATH: cftz, TEST_BASE: base },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  assert.equal(exitCode, 0, stderr);
  assert.equal(requests.length, 2);

  assert.equal(requests[0].url, '/agent');
  assert.equal(requests[0].headers.authorization, 'Bearer agent-secret');
  assert.equal(requests[0].headers['x-admin-session'], undefined);

  assert.equal(requests[1].url, '/admin');
  assert.equal(requests[1].headers['x-admin-session'], 'session-secret');
  assert.equal(requests[1].headers.authorization, undefined);
} finally {
  await new Promise((resolve) => server.close(resolve));
}

console.log('cftz authentication handshake tests passed');
