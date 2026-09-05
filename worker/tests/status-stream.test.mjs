import assert from 'node:assert/strict';
import { StatusStream, compactStatusEvents } from '../src/status-stream.js';
import { internalRequestHeaders } from '../src/auth.js';

const events = compactStatusEvents([
  {
    target_id: 'VPS-A',
    saved: {
      state_update: {
        target_id: 'VPS-A',
        checked_at: 100,
        ok: 1,
        latency_ms: 20,
        daily: { '2026-08-21': { total: 99 } },
      },
    },
  },
  {
    target_id: 'vps-a',
    checked_at: 90,
    ok: 0,
  },
]);
assert.equal(events.length, 1, 'status events must deduplicate target updates');
assert.equal(events[0].target_id, 'VPS-A');
assert.equal(events[0].checked_at, 100);
assert.equal('daily' in events[0], false, 'status events must not carry the full daily history');

const sockets = [
  { messages: [], send(value) { this.messages.push(JSON.parse(value)); } },
  { messages: [], send(value) { this.messages.push(JSON.parse(value)); } },
];
const env = { INTERNAL_CRON_SECRET: 'status-stream-test-secret' };
const state = {
  getWebSockets() { return sockets; },
  acceptWebSocket() {},
};
const stream = new StatusStream(state, env);
const published = await stream.broadcast(events);
assert.deepEqual(published, { ok: true, delivered: 2, events: 1 });
assert.equal(sockets[0].messages[0].type, 'status_update');
assert.equal(sockets[0].messages[0].events[0].latency_ms, 20);

const response = await stream.fetch(new Request('https://nie-sla.internal/publish', {
  method: 'POST',
  headers: { ...internalRequestHeaders(env), 'content-type': 'application/json' },
  body: JSON.stringify({ events: [] }),
}));
assert.equal(response.status, 200);
assert.deepEqual(await response.json(), { ok: true, skipped: true, reason: 'no_events', delivered: 0 });

console.log('status stream tests passed');
