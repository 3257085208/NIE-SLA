import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const manifest = JSON.parse(await readFile(path.join(root, 'update-manifest.json'), 'utf8'));
const workflow = await readFile(path.join(root, '.github/workflows/nie-sla-update.yml'), 'utf8');
const versionSource = await readFile(path.join(root, 'worker/src/version.js'), 'utf8');
const updateSource = await readFile(path.join(root, 'worker/src/app-update.js'), 'utf8');
const version = versionSource.match(/VERSION\s*=\s*['"]([^'"]+)['"]/u)?.[1];

assert.equal(manifest.schema, 'nie-sla-app-update-v1');
assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
assert.equal(manifest.source_ref, `app-v${manifest.version}`);
assert.equal(version, manifest.version, 'public Worker version must match the update manifest');
assert.ok(Array.isArray(manifest.changelog) && manifest.changelog.length > 0);
assert.ok(Number.isFinite(Date.parse(manifest.published_at)));

assert.match(workflow, /workflow_dispatch:/);
assert.match(workflow, /contents: write/);
assert.match(workflow, /\^app-v\[0-9\]\+/);
assert.match(workflow, /refs\/tags\/\$SOURCE_REF/);
assert.match(workflow, /wrangler\.deployment\.jsonc/);
assert.match(workflow, /cp "\$RUNNER_TEMP\/wrangler\.deployment\.jsonc" wrangler\.jsonc/);
assert.match(workflow, /git archive "refs\/tags\/\$CURRENT_REF"/);
assert.match(workflow, /rsync -rlpcni --delete/);
assert.match(workflow, /Only wrangler\.jsonc may differ/);
assert.match(workflow, /pnpm run build/);
assert.match(workflow, /pnpm test/);
assert.match(workflow, /bash test\.sh/);
assert.match(workflow, /wrangler deploy --dry-run/);
assert.doesNotMatch(workflow, /CLOUDFLARE_API_TOKEN|CLOUDFLARE_ACCOUNT_ID/);

assert.match(updateSource, /token_stored:\s*false/);
assert.doesNotMatch(updateSource, /setMeta\([^\n]*github_token/);

console.log(`application update contract passed (${manifest.version})`);
