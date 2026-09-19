import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const agentRoot = path.resolve(import.meta.dirname, '..');
// Private workspaces keep the production frontend in a sibling directory, while
// the sanitized public snapshot (and every one-click deployment repository
// built from it) ships it inside the repository. Resolve the sibling only when
// it really is the production frontend, otherwise fall back to the in-repo copy
// so the online-update validation can run outside the umbrella workspace.
const configuredFrontend = process.env.NIE_SLA_FRONTEND_ROOT
  ? path.resolve(process.env.NIE_SLA_FRONTEND_ROOT)
  : null;
const siblingFrontend = path.resolve(agentRoot, '..', 'frontend');
const frontendRoot = configuredFrontend
  || (existsSync(path.join(siblingFrontend, 'AGENTS.md')) ? siblingFrontend : path.join(agentRoot, 'frontend'));

assert.ok(
  existsSync(path.join(frontendRoot, 'tests', 'frontend-modules.test.mjs')),
  `production Frontend module test is required: ${frontendRoot}`,
);
await import(pathToFileURL(path.join(frontendRoot, 'tests', 'frontend-modules.test.mjs')).href);
