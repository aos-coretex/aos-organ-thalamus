import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createNomosAtmHandler } from '../handlers/nomos-atm.js';

function fakeDispatcher() {
  const calls = [];
  return {
    calls,
    dispatchWriteAfterAuth: async (args) => { calls.push(args); return { dispatched: true }; },
  };
}

test('valid ATM from Nomos -> calls dispatcher', async () => {
  const dispatcher = fakeDispatcher();
  const handler = createNomosAtmHandler({ dispatcher });
  const result = await handler({ type: 'ATM', source_organ: 'Nomos', payload: { ap_ref: 'urn:apm:1' } });
  assert.equal(result.dispatched, true);
  assert.equal(dispatcher.calls.length, 1);
});

test('wrong type -> not_atm', async () => {
  const handler = createNomosAtmHandler({ dispatcher: fakeDispatcher() });
  const result = await handler({ type: 'OTM', source_organ: 'Nomos', payload: {} });
  assert.equal(result.handled, false);
  assert.equal(result.reason, 'not_atm');
});

test('wrong source_organ -> wrong_source_organ', async () => {
  const handler = createNomosAtmHandler({ dispatcher: fakeDispatcher() });
  const result = await handler({ type: 'ATM', source_organ: 'Cerberus', payload: {} });
  assert.equal(result.handled, false);
  assert.equal(result.reason, 'wrong_source_organ');
});
