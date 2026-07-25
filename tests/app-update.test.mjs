import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const manifest = JSON.parse(await readFile(path.join(root, 'update-manifest.json'), 'utf8'));
const workflow = await readFile(path.join(root, '.github/workflows/nie-sla-update.yml'), 'utf8');
const publicCi = await readFile(path.join(root, '.github/workflows/public-ci.yml'), 'utf8');
const versionSource = await readFile(path.join(root, 'worker/src/version.js'), 'utf8');
const updateSource = await readFile(path.join(root, 'worker/src/app-update.js'), 'utf8');
const routesSource = await readFile(path.join(root, 'worker/src/routes.js'), 'utf8');
const version = versionSource.match(/VERSION\s*=\s*['"]([^'"]+)['"]/u)?.[1];

assert.equal(manifest.schema, 'nie-sla-app-update-v1');
assert.match(manifest.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/);
assert.match(manifest.version, /-beta\.\d+$/, 'current application release must carry a Beta prerelease identifier');
assert.equal(manifest.source_ref, `app-v${manifest.version}`);
assert.equal(version, manifest.version, 'public Worker version must match the update manifest');
assert.ok(Array.isArray(manifest.changelog) && manifest.changelog.length > 0);
assert.ok(Number.isFinite(Date.parse(manifest.published_at)));

assert.match(workflow, /workflow_dispatch:/);
assert.match(workflow, /schedule:[\s\S]*cron: "17 \*\/6 \* \* \*"/);
assert.doesNotMatch(workflow, /inputs:[\s\S]*(?:source_ref|expected_version)/);
assert.match(workflow, /contents: write/);
assert.match(workflow, /raw\.githubusercontent\.com\/3257085208\/NIE-SLA\/main\/update-manifest\.json/);
assert.match(workflow, /UPDATE_AVAILABLE=/);
assert.match(workflow, /prerelease/, 'online updates must compare prerelease versions');
assert.match(workflow, /if: env\.UPDATE_AVAILABLE == 'true'/);
assert.match(workflow, /refs\/tags\/\$SOURCE_REF/);
assert.match(workflow, /wrangler\.deployment\.jsonc/);
assert.match(workflow, /cp "\$RUNNER_TEMP\/wrangler\.deployment\.jsonc" wrangler\.jsonc/);
assert.match(workflow, /git archive "refs\/tags\/\$CURRENT_REF"/);
assert.match(workflow, /rsync -rlpcni --delete/);
assert.match(workflow, /Only wrangler\.jsonc may differ/);
assert.match(workflow, /pnpm run build/);
assert.match(workflow, /NIE_SLA_DEPLOYMENT_VALIDATION=1 pnpm test/);
assert.match(workflow, /pnpm run test:update/);
assert.doesNotMatch(workflow, /bash test\.sh|rustup|musl-tools/);
assert.match(workflow, /wrangler deploy --dry-run/);
assert.doesNotMatch(workflow, /CLOUDFLARE_API_TOKEN|CLOUDFLARE_ACCOUNT_ID|github_token|fine-grained|personal access token/i);
assert.match(publicCi, /if: github\.repository == '3257085208\/NIE-SLA'/, 'deployment repositories must not run the official snapshot CI');

assert.match(updateSource, /update_mode:\s*'github-actions'/);
assert.match(updateSource, /automatic_check_hours:\s*6/);
assert.doesNotMatch(updateSource, /repository|token_stored|github_token|dispatchAppUpdate/);
assert.doesNotMatch(routesSource, /path === '\/api\/system\/update' && m === 'POST'/);

console.log(`application update contract passed (${manifest.version})`);
