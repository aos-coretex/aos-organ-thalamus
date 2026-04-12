import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDirectedHandler } from '../handlers/spine-commands.js';

function fakeIntakeRouter() {
  const calls = [];
  return {
    calls,
    fn: async (env) => { calls.push(env); return { handled: true, job_urn: 'urn:job:1' }; },
  };
}

function fakePlanner() {
  const calls = [];
  return { calls, planAndDispatch: async (j) => { calls.push(j); return { planned: true }; } };
}

function fakeDispatcher() {
  const calls = [];
  const make = (name) => async (args) => { calls.push({ name, ...args }); return { handled: true, status: 'ok' }; };
  return {
    calls,
    handleAdjudicationResult: make('adjudication_result'),
    handleAdjudicationHeld: make('adjudication_held'),
    handleApmRejected: make('apm_rejected'),
  };
}

function fakeNomosAtmHandler() {
  const calls = [];
  return { calls, fn: async (env) => { calls.push(env); return { dispatched: true }; } };
}

function fakeJobLifecycle() {
  return { getJob: () => ({ job_urn: 'urn:job:1' }) };
}

function setup() {
  const intake = fakeIntakeRouter();
  const planner = fakePlanner();
  const dispatcher = fakeDispatcher();
  const nomosAtm = fakeNomosAtmHandler();
  const handler = createDirectedHandler({
    intakeRouter: intake.fn,
    planner,
    dispatcher,
    nomosAtmHandler: nomosAtm.fn,
    jobLifecycle: fakeJobLifecycle(),
  });
  return { handler, intake, planner, dispatcher, nomosAtm };
}

test('ATM message -> nomosAtmHandler called', async () => {
  const { handler, nomosAtm } = setup();
  await handler({ type: 'ATM', source_organ: 'Nomos', payload: { ap_ref: 'x' } });
  assert.equal(nomosAtm.calls.length, 1);
});

test('OTM autonomous_goal -> intakeRouter + planner async', async () => {
  const { handler, intake } = setup();
  const result = await handler({ type: 'OTM', source_organ: 'Cortex', payload: { event_type: 'autonomous_goal' } });
  assert.equal(result.handled, true);
  assert.equal(intake.calls.length, 1);
});

test('OTM ingress_request -> intakeRouter', async () => {
  const { handler, intake } = setup();
  await handler({ type: 'OTM', source_organ: 'Receptor', payload: { event_type: 'ingress_request' } });
  assert.equal(intake.calls.length, 1);
});

test('OTM adjudication_result -> dispatcher', async () => {
  const { handler, dispatcher } = setup();
  await handler({ type: 'OTM', payload: { event_type: 'adjudication_result', ruling: 'Authorized' } });
  assert.ok(dispatcher.calls.some(c => c.name === 'adjudication_result'));
});

test('OTM adjudication_held -> dispatcher', async () => {
  const { handler, dispatcher } = setup();
  await handler({ type: 'OTM', payload: { event_type: 'adjudication_held' } });
  assert.ok(dispatcher.calls.some(c => c.name === 'adjudication_held'));
});

test('OTM apm_rejected -> dispatcher', async () => {
  const { handler, dispatcher } = setup();
  await handler({ type: 'OTM', payload: { event_type: 'apm_rejected' } });
  assert.ok(dispatcher.calls.some(c => c.name === 'apm_rejected'));
});

test('OTM health_check -> returns health_response', async () => {
  const { handler } = setup();
  const result = await handler({ type: 'OTM', source_organ: 'Vigil', payload: { event_type: 'health_check' } });
  assert.equal(result.payload.event_type, 'health_response');
  assert.equal(result.source_organ, 'Thalamus');
  assert.equal(result.target_organ, 'Vigil');
});

test('APM type -> rejected', async () => {
  const { handler } = setup();
  const result = await handler({ type: 'APM', source_organ: 'Someone', payload: {} });
  assert.equal(result.handled, false);
  assert.equal(result.error, 'thalamus_does_not_consume_this_type');
});

test('PEM type -> rejected', async () => {
  const { handler } = setup();
  const result = await handler({ type: 'PEM', payload: {} });
  assert.equal(result.handled, false);
});

test('HOM type -> rejected', async () => {
  const { handler } = setup();
  const result = await handler({ type: 'HOM', payload: {} });
  assert.equal(result.handled, false);
});

test('unknown OTM event_type -> null (silent absorb)', async () => {
  const { handler } = setup();
  const result = await handler({ type: 'OTM', payload: { event_type: 'something_unknown' } });
  assert.equal(result, null);
});
