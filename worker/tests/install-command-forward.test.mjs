import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { webcrypto } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { getAgentInstallCommand, getAgentInstallScript } from '../src/admin/install-command.js';
import { ensureV6Schema } from '../src/admin/schema.js';

globalThis.crypto ||= webcrypto;

const database = new DatabaseSync(':memory:');
const env = {
  TOTP_ENCRYPTION_KEY: 'install-forward-encryption-key-32-bytes',
  DB: d1(database),
  PUBLIC_SITE_ORIGIN: 'https://status.example.test',
  PUBLIC_AGENT_API_BASE: 'https://api.example.test',
};
await ensureV6Schema(env);

const now = Math.floor(Date.now() / 1000);
database.prepare(`INSERT INTO targets
  (id, name, group_name, type, target_host, target_port, timeout_ms, interval_sec, probe_region, enabled, created_at, updated_at)
  VALUES (?, ?, 'VPS', 'tcp', '203.0.113.10', 443, 5000, 300, 'auto', 1, ?, ?)`)
  .run('vps-forward', 'VPS Forward', now, now);

const originalFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  const target = String(url);
  if (target.endsWith('/bin/VERSION')) return new Response('v1.2.3\n');
  if (target.endsWith('/bin/SHA256SUMS')) return new Response('abc  nstatus-metrics-linux-amd64\n');
  return new Response('', { status: 404 });
};

try {
  const request = new Request('https://api.example.test/admin', { headers: { origin: 'https://status.example.test' } });

  const plain = await getAgentInstallCommand(
    env,
    new URL('https://api.example.test/api/agent/install-command?target_id=vps-forward'),
    request,
  );
  assert.equal(plain.ok, true);
  assert.match(plain.linux_command, /-o "\$t" && sh "\$t"\)$/, 'the default one-click command must stay unchanged');
  assert.match(plain.linux_command_rootless, /-o "\$t" && sh "\$t" --rootless\)$/, 'the rootless one-liner must keep --rootless');
  for (const command of [plain.linux_command, plain.linux_command_rootless]) {
    assert.doesNotMatch(command, /[A-Z_]+='/, 'one-liners must never embed long-lived env secrets');
  }

  const replacing = await getAgentInstallCommand(
    env,
    new URL('https://api.example.test/api/agent/install-command?target_id=vps-forward'),
    request,
    { replaceAgent: 'nezha' },
  );
  assert.equal(replacing.ok, true);
  assert.match(replacing.linux_command, /sh "\$t" --replace-agent nezha\)$/);
  assert.match(replacing.linux_command_rootless, /sh "\$t" --rootless --replace-agent nezha\)$/);

  const ticket = replacing.linux_command.match(/Bearer (nsi_[a-f0-9]{48})/)?.[1];
  assert.ok(ticket);
  const wrapper = await (await getAgentInstallScript(env, new Request('https://api.example.test/api/agent/install-script', {
    headers: { authorization: `Bearer ${ticket}` },
  }))).text();

  // The generated wrapper must forward every setup.sh flag it receives.
  assert.match(
    wrapper,
    /for arg in "\$@"; do if \[ "\$arg" = "--rootless" \]; then rootless=1; fi; done/,
    'the wrapper must detect --rootless to stay rootless (never sudo)',
  );
  assert.match(wrapper, /sh "\$tmp" --non-interactive "\$@"/, 'the root path must forward all flags to install.sh');
  assert.match(wrapper, /sudo --preserve-env=[^ ]+ sh "\$tmp" --non-interactive "\$@"/, 'the sudo path must forward all flags too');

  // install.sh must keep passing every flag through to setup.sh, and setup.sh
  // must keep parsing both flags.
  const installSh = readFileSync(new URL('../../agent/install.sh', import.meta.url), 'utf8');
  assert.match(installSh, /bash "\$tmp" "\$@"/, 'install.sh must forward its arguments to setup.sh');
  const setupSh = readFileSync(new URL('../../agent/setup.sh', import.meta.url), 'utf8');
  assert.match(setupSh, /--rootless\)/, 'setup.sh must parse --rootless');
  assert.match(setupSh, /--replace-agent\)/, 'setup.sh must parse --replace-agent');

  runWrapperMatrix(wrapper);
} finally {
  globalThis.fetch = originalFetch;
}

console.log('install command forwarding tests passed');

function runWrapperMatrix(wrapper) {
  const temp = mkdtempSync(join(tmpdir(), 'nie-sla-install-forward-'));
  try {
    const bin = join(temp, 'bin');
    mkdirSync(bin);
    const wrapperPath = join(temp, 'wrapper.sh');
    writeFileSync(wrapperPath, wrapper);

    const installerSha = wrapper.match(/NIE_SLA_INSTALLER_SHA256='([a-f0-9]{64})'/)?.[1];
    assert.ok(installerSha, 'the wrapper must pin the installer SHA-256');

    const installer = join(temp, 'mock-install.sh');
    writeFileSync(installer, '#!/bin/sh\nprintf \'%s\\n\' "$@" > "$NIE_SLA_TEST_ARGS"\n');

    writeScript(join(bin, 'curl'), `#!/bin/sh
out=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    *) shift ;;
  esac
done
cp "$NIE_SLA_TEST_INSTALLER" "$out"
`);
    writeScript(join(bin, 'sha256sum'), '#!/bin/sh\nprintf \'%s  mock\\n\' "$NIE_SLA_TEST_INSTALLER_SHA"\n');
    writeScript(join(bin, 'id'), `#!/bin/sh
if [ "\${1:-}" = "-u" ]; then printf '%s\\n' "\${NIE_SLA_TEST_UID:-1000}"; exit 0; fi
exec /usr/bin/id "$@"
`);
    writeScript(join(bin, 'sudo'), '#!/bin/sh\nprintf \'sudo\\n\' >> "$NIE_SLA_TEST_SUDO_LOG"\nshift\nexec "$@"\n');

    const argsFile = join(temp, 'installer-args.txt');
    const sudoLog = join(temp, 'sudo.log');

    const run = (args, uid) => {
      writeFileSync(argsFile, '');
      writeFileSync(sudoLog, '');
      const result = spawnSync('sh', [wrapperPath, ...args], {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          NIE_SLA_TEST_UID: String(uid),
          NIE_SLA_TEST_INSTALLER: installer,
          NIE_SLA_TEST_INSTALLER_SHA: installerSha,
          NIE_SLA_TEST_ARGS: argsFile,
          NIE_SLA_TEST_SUDO_LOG: sudoLog,
        },
      });
      assert.equal(result.status, 0, `wrapper failed: ${result.stderr}`);
      return {
        args: readFileSync(argsFile, 'utf8').trim().split('\n').filter(Boolean),
        sudo: readFileSync(sudoLog, 'utf8').trim() !== '',
      };
    };

    // 1. One-click install as root: no flags, no sudo, installer still gets
    //    --non-interactive exactly like before.
    let result = run([], 0);
    assert.deepEqual(result.args, ['--non-interactive']);
    assert.equal(result.sudo, false);

    // 2. One-click install as an unprivileged user: sudo elevation keeps
    //    forwarding the (empty) flag set.
    result = run([], 1000);
    assert.deepEqual(result.args, ['--non-interactive']);
    assert.equal(result.sudo, true);

    // 3. Rootless install as an unprivileged user must never use sudo and must
    //    deliver --rootless to install.sh/setup.sh.
    result = run(['--rootless'], 1000);
    assert.deepEqual(result.args, ['--non-interactive', '--rootless']);
    assert.equal(result.sudo, false, 'rootless installs must stay in the user session');

    // 4. Migration --replace-agent reaches setup.sh through the root path.
    result = run(['--replace-agent', 'nezha'], 0);
    assert.deepEqual(result.args, ['--non-interactive', '--replace-agent', 'nezha']);

    // 5. Rootless and --replace-agent combined stay intact.
    result = run(['--rootless', '--replace-agent', 'komari'], 1000);
    assert.deepEqual(result.args, ['--non-interactive', '--rootless', '--replace-agent', 'komari']);
    assert.equal(result.sudo, false);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

function writeScript(file, source) {
  writeFileSync(file, source);
  chmodSync(file, 0o755);
}

function d1(db) {
  return {
    prepare(sql) {
      let values = [];
      return {
        bind(...params) { values = params; return this; },
        async run() { return db.prepare(sql).run(...values); },
        async all() { return { results: db.prepare(sql).all(...values) }; },
        async first() { return db.prepare(sql).get(...values) || null; },
      };
    },
    async batch(statements) {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      return results;
    },
  };
}
