import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCerberusBroadcastHandler } from '../handlers/cerberus-broadcast.js';

function fakeDispatcher() {
  const calls = [];
  const make = (name) => async (args) => { calls.push({ name, args }); return { handled: true }; };
  return {
    calls,
    handleExecutionCompleted: make('completed'),
    handleExecutionDenied: make('denied'),
    handleExecutionFailed: make('failed'),
  };
}

test('execution_completed routes to handleExecutionCompleted', async () => {
  const dispatcher = fakeDispatcher();
  const handler = createCerberusBroadcastHandler({ dispatcher });
  const result = await handler({ source_organ: 'Cerberus', payload: { event_type: 'execution_completed' } });
  assert.equal(result.handled, true);
  assert.equal(dispatcher.calls[0].name, 'completed');
});

test('execution_denied routes to handleExecutionDenied', async () => {
  const dispatcher = fakeDispatcher();
  const handler = createCerberusBroadcastHandler({ dispatcher });
  await handler({ source_organ: 'Cerberus', payload: { event_type: 'execution_denied' } });
  assert.equal(dispatcher.calls[0].name, 'denied');
});

test('execution_failed routes to handleExecutionFailed', async () => {
  const dispatcher = fakeDispatcher();
  const handler = createCerberusBroadcastHandler({ dispatcher });
  await handler({ source_organ: 'Cerberus', payload: { event_type: 'execution_failed' } });
  assert.equal(dispatcher.calls[0].name, 'failed');
});

test('non-Cerberus source -> silent ignore', async () => {
  const handler = createCerberusBroadcastHandler({ dispatcher: fakeDispatcher() });
  const result = await handler({ source_organ: 'Nomos', payload: { event_type: 'execution_completed' } });
  assert.equal(result.handled, false);
  assert.equal(result.reason, 'not_from_cerberus');
});

test('unknown event_type -> handled:false', async () => {
  const handler = createCerberusBroadcastHandler({ dispatcher: fakeDispatcher() });
  const result = await handler({ source_organ: 'Cerberus', payload: { event_type: 'some_other_event' } });
  assert.equal(result.handled, false);
  assert.equal(result.reason, 'unknown_cerberus_event_type');
});
