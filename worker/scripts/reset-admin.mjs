#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { createAdminCredentialRecord } from '../src/admin-auth.js';

const args = new Set(process.argv.slice(2));
const local = args.has('--local');
const disableTotp = args.has('--disable-totp');
const database = argumentValue('--database') || 'nie-sla-db';
const username = String(
  argumentValue('--username')
  || process.env.NIE_SLA_ADMIN_USERNAME
  || process.env.NSTATUS_ADMIN_USERNAME
  || await ask('新管理员账号 [admin]: ')
  || 'admin',
).trim();
const password = process.env.NIE_SLA_ADMIN_PASSWORD || process.env.NSTATUS_ADMIN_PASSWORD || await askHidden('新管理员密码: ');
const confirmation = process.env.NIE_SLA_ADMIN_PASSWORD || process.env.NSTATUS_ADMIN_PASSWORD || await askHidden('再次输入新密码: ');

if (password !== confirmation) fail('两次输入的密码不一致');

let record;
try {
  record = await createAdminCredentialRecord(username, password);
} catch (error) {
  fail(error?.message || error);
}

const now = Math.floor(Date.now() / 1000);
const credentialJson = JSON.stringify(record).replaceAll("'", "''");
const resetKeys = [
  'totp_sessions',
  'totp_session_id',
  'totp_session_expires',
  'github_oauth_states',
  'github_oauth_tickets',
];
if (disableTotp) resetKeys.push('totp_secret', 'totp_pending_secret');
const quotedKeys = resetKeys.map((key) => `'${key}'`).join(', ');
const sql = [
  `INSERT INTO app_meta (key, value, updated_at) VALUES ('admin_credentials_v1', '${credentialJson}', ${now}) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at;`,
  `DELETE FROM app_meta WHERE key IN (${quotedKeys});`,
].join('\n');

const directory = await mkdtemp(path.join(tmpdir(), 'nie-sla-admin-reset-'));
const sqlFile = path.join(directory, 'reset.sql');
const workerDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try {
  await writeFile(sqlFile, sql, { mode: 0o600 });
  const result = spawnSync(
    process.platform === 'win32' ? 'npx.cmd' : 'npx',
    ['wrangler', 'd1', 'execute', database, local ? '--local' : '--remote', '--file', sqlFile],
    { cwd: workerDirectory, stdio: 'inherit' },
  );
  if (result.error) fail(result.error.message);
  if (result.status !== 0) process.exit(result.status || 1);
} finally {
  await rm(directory, { recursive: true, force: true });
}

console.log(`管理员账号已强制重置为 ${username}，所有管理会话已注销。`);
if (disableTotp) console.log('TOTP 已同时关闭，请登录后重新启用。');

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] || '' : '';
}

async function ask(prompt) {
  if (!process.stdin.isTTY) return '';
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try { return await rl.question(prompt); } finally { rl.close(); }
}

async function askHidden(prompt) {
  if (!process.stdin.isTTY || !process.stdin.setRawMode) fail('非交互环境请设置 NIE_SLA_ADMIN_PASSWORD');
  process.stdout.write(prompt);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');
  return new Promise((resolve, reject) => {
    let value = '';
    const finish = () => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.off('data', onData);
      process.stdout.write('\n');
      resolve(value);
    };
    const onData = (chunk) => {
      if (chunk === '\u0003') {
        process.stdin.setRawMode(false);
        process.stdout.write('\n');
        reject(new Error('已取消'));
      } else if (chunk === '\r' || chunk === '\n') finish();
      else if (chunk === '\u007f' || chunk === '\b') value = value.slice(0, -1);
      else if (!/[\u0000-\u001f]/.test(chunk)) value += chunk;
    };
    process.stdin.on('data', onData);
  });
}

function fail(message) {
  console.error(`重置失败：${String(message || '未知错误')}`);
  process.exit(1);
}
