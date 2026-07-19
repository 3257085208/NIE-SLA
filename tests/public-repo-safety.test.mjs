import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const tracked = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root })
  .toString('utf8').split('\0').filter(Boolean);
const textFiles = tracked.filter((file) =>
  existsSync(path.join(root, file))
  && !/\.(?:png|jpe?g|gif|ico|woff2?|exe)$/i.test(file)
  && !/(?:^|\/)vendor\//.test(file)
  && !/(?:^|\/)Cargo\.lock$/.test(file)
  && !/(?:^|\/)bin\//.test(file));

const checks = [
  ['production domain', /(?:niekaixiang\.com|nkx\.workers\.dev)/i],
  ['Agent token', /\bnst_[a-f0-9]{32,}\b/i],
  ['GitHub token', /\b(?:ghp|github_pat)_[A-Za-z0-9_]{20,}\b/],
  ['Telegram bot token', /\b\d{8,12}:[A-Za-z0-9_-]{30,}\b/],
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['Windows user path', /[A-Za-z]:\\Users\\[^\\\s]+\\/i],
  ['Unix home path', /\/home\/(?!user(?:\/|\b)|runner(?:\/|\b))[A-Za-z0-9._-]+\//],
];

const findings = [];
for (const file of textFiles) {
  const source = readFileSync(path.join(root, file), 'utf8');
  for (const [name, pattern] of checks) {
    if (pattern.test(source)) findings.push(`${name}: ${file}`);
  }
  if (file.endsWith('wrangler.toml')) {
    const ids = [...source.matchAll(/database_id\s*=\s*"([0-9a-f-]{36})"/gi)].map((match) => match[1]);
    if (ids.some((id) => id !== '00000000-0000-0000-0000-000000000000')) findings.push(`Cloudflare database ID: ${file}`);
  }
}

assert.deepEqual(findings, [], `public repository contains sensitive deployment data:\n${findings.join('\n')}`);
console.log(`public repository safety scan passed (${textFiles.length} text files)`);
