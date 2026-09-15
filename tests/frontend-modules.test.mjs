import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const agentRoot = path.resolve(import.meta.dirname, '..');
const configuredFrontend = process.env.NIE_SLA_FRONTEND_ROOT
  ? path.resolve(process.env.NIE_SLA_FRONTEND_ROOT)
  : path.resolve(agentRoot, '..', 'frontend');

assert.ok(
  existsSync(path.join(configuredFrontend, 'tests', 'frontend-modules.test.mjs')),
  `production Frontend module test is required: ${configuredFrontend}`,
);
await import(pathToFileURL(path.join(configuredFrontend, 'tests', 'frontend-modules.test.mjs')).href);
