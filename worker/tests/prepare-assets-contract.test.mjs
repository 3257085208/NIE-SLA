import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const workerRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = await readFile(path.join(workerRoot, 'scripts', 'prepare-assets.mjs'), 'utf8');

assert.match(source, /assertCleanGitRepository\(agentRoot, 'Agent'\)/);
assert.match(source, /assertCleanGitRepository\(frontendRoot, 'Frontend'\)/);
assert.match(source, /'archive'/);
assert.match(source, /asset_source: 'git-archive'/);
assert.match(source, /build-provenance\.json/);
assert.match(source, /update_manifest_sha256: manifestSha256/);
assert.match(source, /agentRelease !== manifest\.agent_version/);
assert.match(source, /await rename\(stagingOutput, outputRoot\)/);
assert.doesNotMatch(source, /randomBytes/);
assert.doesNotMatch(source, /cp\(frontendRoot/);

const deploy = await readFile(path.join(workerRoot, 'deploy.sh'), 'utf8');
assert.match(deploy, /bash \"\$ROOT\/\.\.\/test\.sh\"/);
assert.match(deploy, /NIE_SLA_FRONTEND_REF/);
assert.match(deploy, /FRONTEND_HEAD[\s\S]{0,260}FRONTEND_REF_COMMIT[\s\S]{0,260}测试门禁不能覆盖另一个 commit/);
assert.match(deploy, /deploy --dry-run/);
assert.match(deploy, /build-provenance\.json/);

console.log('prepare-assets provenance contract passed');
