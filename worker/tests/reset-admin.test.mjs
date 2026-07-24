import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const directory = await mkdtemp(path.join(tmpdir(), 'nstatus-reset-test-'));
const captureFile = path.join(directory, 'capture.json');
const mockNpx = path.join(directory, process.platform === 'win32' ? 'npx.cmd' : 'npx');
const password = 'test-only strong password';

try {
  if (process.platform === 'win32') {
    await writeFile(mockNpx, '@echo off\r\nnode "%~dp0\\mock-npx.mjs" %*\r\n');
  } else {
    await writeFile(mockNpx, '#!/bin/sh\nexec "' + process.execPath.replaceAll('"', '\\"') + '" "$(dirname "$0")/mock-npx.mjs" "$@"\n');
    await chmod(mockNpx, 0o755);
  }
  await writeFile(path.join(directory, 'mock-npx.mjs'), `
    import { readFileSync, writeFileSync } from 'node:fs';
    const args = process.argv.slice(2);
    const fileIndex = args.indexOf('--file');
    const sql = fileIndex >= 0 ? readFileSync(args[fileIndex + 1], 'utf8') : '';
    writeFileSync(process.env.NSTATUS_RESET_CAPTURE, JSON.stringify({ args, sql }));
  `);

  const result = spawnSync(process.execPath, [
    fileURLToPath(new URL('../scripts/reset-admin.mjs', import.meta.url)),
    '--local',
    '--disable-totp',
    '--database',
    'custom-db',
  ], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${directory}${path.delimiter}${process.env.PATH || ''}`,
      NSTATUS_ADMIN_USERNAME: 'reset.owner',
      NSTATUS_ADMIN_PASSWORD: password,
      NSTATUS_RESET_CAPTURE: captureFile,
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, new RegExp(password));
  const capture = JSON.parse(await readFile(captureFile, 'utf8'));
  assert.deepEqual(capture.args.slice(0, 5), ['wrangler', 'd1', 'execute', 'custom-db', '--local']);
  assert.doesNotMatch(JSON.stringify(capture.args), new RegExp(password));
  assert.doesNotMatch(capture.sql, new RegExp(password));
  assert.match(capture.sql, /admin_credentials_v1/);
  assert.match(capture.sql, /pbkdf2-sha256/);
  assert.match(capture.sql, /totp_sessions/);
  assert.match(capture.sql, /github_oauth_tickets/);
  assert.match(capture.sql, /totp_secret/);
} finally {
  await rm(directory, { recursive: true, force: true });
}

console.log('admin reset tests passed');
