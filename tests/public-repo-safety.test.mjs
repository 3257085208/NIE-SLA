import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const deploymentValidation = process.env.NIE_SLA_DEPLOYMENT_VALIDATION === '1';
const tracked = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root })
  .toString('utf8').split('\0').filter(Boolean);
const textFiles = tracked.filter((file) =>
  existsSync(path.join(root, file))
  && !/\.(?:png|jpe?g|gif|ico|woff2?|exe)$/i.test(file)
  && !/(?:^|\/)vendor\//.test(file)
  && !/(?:^|\/)Cargo\.lock$/.test(file)
  && !/(?:^|\/)bin\//.test(file));
const hiddenImageHost = new RegExp(['img', 'nkx', 'moe'].join('\\.'), 'i');
const publicNqBrokerUrl = ['https://api-sla', 'niekaixiang', 'com/api/nq/image-broker'].join('.');
const publicNqBrokerPlaceholder = ['https://nq-public-broker', 'invalid/api/nq/image-broker'].join('.');

const checks = [
  ['production domain', /(?:niekaixiang\.com|nkx\.workers\.dev)/i],
  ['private image host', hiddenImageHost],
  ['Agent token', /\bnst_[a-f0-9]{32,}\b/i],
  ['GitHub token', /\b(?:ghp|github_pat)_[A-Za-z0-9_]{20,}\b/],
  ['Telegram bot token', /\b\d{8,12}:[A-Za-z0-9_-]{30,}\b/],
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['Windows user path', /[A-Za-z]:\\Users\\[^\\\s]+\\/i],
  ['Unix home path', /\/home\/(?!user(?:\/|\b)|runner(?:\/|\b))[A-Za-z0-9._-]+\//],
];

const findings = [];
for (const file of textFiles) {
  const source = readFileSync(path.join(root, file), 'utf8')
    .replaceAll(publicNqBrokerUrl, publicNqBrokerPlaceholder);
  for (const [name, pattern] of checks) {
    if (pattern.test(source)) findings.push(`${name}: ${file}`);
  }
  if (/wrangler\.(?:toml|jsonc?)$/i.test(file)) {
    const ids = [...source.matchAll(/database_id["']?\s*(?:=|:)\s*"([0-9a-f-]{36})"/gi)].map((match) => match[1]);
    if (!deploymentValidation && ids.some((id) => id !== '00000000-0000-0000-0000-000000000000')) findings.push(`Cloudflare database ID: ${file}`);
    if (!deploymentValidation && /nie-sla-private/i.test(source)) findings.push(`private Cloudflare Worker name: ${file}`);
  }
}

const publicWorkerWrangler = readFileSync(path.join(root, 'worker', 'wrangler.toml'), 'utf8');
assert.doesNotMatch(publicWorkerWrangler, /^NQ_PUBLIC_BROKER_ENABLED\s*=/m, 'public examples must not expose the official broker endpoint');
assert.doesNotMatch(publicWorkerWrangler, /nie-sla-private/, 'public examples must not inherit the private Worker name');
assert.match(publicWorkerWrangler, /^name = "nie-sla"$/m, 'new public deployments must use the NIE-SLA Worker name');
assert.match(publicWorkerWrangler, /database_name = "nie-sla-db"/, 'new public deployments must use the NIE-SLA D1 name');
assert.match(publicWorkerWrangler, /bucket_name = "nie-sla-archive"/, 'new public deployments must use the NIE-SLA R2 name');

assert.deepEqual(findings, [], `public repository contains sensitive deployment data:\n${findings.join('\n')}`);
console.log(`public repository safety scan passed (${textFiles.length} text files)`);
