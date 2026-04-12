import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBroadcastHandler } from '../handlers/broadcast.js';

function fakeMissionLoader() {
  const calls = [];
  return { calls, invalidate: (reason) => { calls.push(reason); } };
}

function fakeCerberusBroadcastHandler() {
  const calls = [];
  return { calls, fn: async (env) => { calls.push(env); return { handled: true }; } };
}

function setup() {
  const ml = fakeMissionLoader();
  const cb = fakeCerberusBroadcastHandler();
  const handler = createBroadcastHandler({ missionLoader: ml, cerberusBroadcastHandler: cb.fn });
  return { handler, ml, cb };
}

test('msp_updated -> missionLoader.invalidate called', async () => {
  const { handler, ml } = setup();
  await handler({ payload: { event_type: 'msp_updated' } });
  assert.equal(ml.calls.length, 1);
  assert.equal(ml.calls[0], 'msp_updated');
});

test('bor_updated -> missionLoader.invalidate called', async () => {
  const { handler, ml } = setup();
  await handler({ payload: { event_type: 'bor_updated' } });
  assert.equal(ml.calls[0], 'bor_updated');
});

test('governance_version_activated -> missionLoader.invalidate called', async () => {
  const { handler, ml } = setup();
  await handler({ payload: { event_type: 'governance_version_activated' } });
  assert.equal(ml.calls[0], 'governance_version_activated');
});

test('execution_completed -> cerberusBroadcastHandler called', async () => {
  const { handler, cb } = setup();
  await handler({ source_organ: 'Cerberus', payload: { event_type: 'execution_completed' } });
  assert.equal(cb.calls.length, 1);
});

test('execution_denied -> cerberusBroadcastHandler called', async () => {
  const { handler, cb } = setup();
  await handler({ source_organ: 'Cerberus', payload: { event_type: 'execution_denied' } });
  assert.equal(cb.calls.length, 1);
});

test('execution_failed -> cerberusBroadcastHandler called', async () => {
  const { handler, cb } = setup();
  await handler({ source_organ: 'Cerberus', payload: { event_type: 'execution_failed' } });
  assert.equal(cb.calls.length, 1);
});

test('state_transition -> silent (no side effects)', async () => {
  const { handler, ml, cb } = setup();
  await handler({ payload: { event_type: 'state_transition' } });
  assert.equal(ml.calls.length, 0);
  assert.equal(cb.calls.length, 0);
});

test('mailbox_pressure -> silent', async () => {
  const { handler, ml, cb } = setup();
  await handler({ payload: { event_type: 'mailbox_pressure' } });
  assert.equal(ml.calls.length, 0);
  assert.equal(cb.calls.length, 0);
});

test('unknown event_type -> silent', async () => {
  const { handler, ml, cb } = setup();
  await handler({ payload: { event_type: 'alien_signal' } });
  assert.equal(ml.calls.length, 0);
  assert.equal(cb.calls.length, 0);
});
