import assert from 'node:assert/strict';
import { normalizeTarget } from '../src/utils.js';

const base = { name: 'X', type: 'tcp', target_host: '1.2.3.4', target_port: 443 };

const custom = normalizeTarget({ ...base, group_name: '  日本线路  ' }, true);
assert.equal(custom.group_name, '日本线路', 'custom group names must be preserved');

const long = normalizeTarget({ ...base, group_name: 'a'.repeat(80) }, true);
assert.equal(long.group_name.length, 32, 'group names are capped at 32 chars');

const ctrl = normalizeTarget({ ...base, group_name: 'A\u0000B\u001fC' }, true);
assert.equal(ctrl.group_name, 'ABC', 'control characters are stripped');

const empty = normalizeTarget({ ...base, group_name: '   ' }, true);
assert.equal(empty.group_name, 'Default', 'blank group names fall back to the default');

console.log('target group tests passed');
