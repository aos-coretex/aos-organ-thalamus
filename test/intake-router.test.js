import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createIntakeRouter, INTAKE_EVENT_TYPES } from '../lib/intake-router.js';

test('autonomous_goal routes to goalIntake', async () => {
  const calls = [];
  const goalIntake = async (env) => { calls.push({ which: 'goal', env }); return { handled: true, job_urn: 'urn:job:1' }; };
  const requestIntake = async (env) => { calls.push({ which: 'request', env }); return { handled: true }; };
  const router = createIntakeRouter({ goalIntake, requestIntake });
  const result = await router({ payload: { event_type: 'autonomous_goal' } });
  assert.equal(result.handled, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].which, 'goal');
});

test('ingress_request routes to requestIntake', async () => {
  const calls = [];
  const goalIntake = async () => ({ handled: true });
  const requestIntake = async (env) => { calls.push({ env }); return { handled: true, job_urn: 'urn:job:2' }; };
  const router = createIntakeRouter({ goalIntake, requestIntake });
  const result = await router({ payload: { event_type: 'ingress_request' } });
  assert.equal(result.handled, true);
  assert.equal(calls.length, 1);
});

test('unknown event_type returns handled:false reason:unknown_event_type', async () => {
  const router = createIntakeRouter({
    goalIntake: async () => ({ handled: true }),
    requestIntake: async () => ({ handled: true }),
  });
  const result = await router({ payload: { event_type: 'execution_completed' } });
  assert.equal(result.handled, false);
  assert.equal(result.reason, 'unknown_event_type');
  assert.equal(result.event_type, 'execution_completed');
});

test('missing payload returns handled:false', async () => {
  const router = createIntakeRouter({
    goalIntake: async () => ({ handled: true }),
    requestIntake: async () => ({ handled: true }),
  });
  const result = await router({});
  assert.equal(result.handled, false);
  assert.equal(result.reason, 'unknown_event_type');
  assert.equal(result.event_type, null);
});

test('INTAKE_EVENT_TYPES exports the recognized set', () => {
  assert.ok(INTAKE_EVENT_TYPES.has('autonomous_goal'));
  assert.ok(INTAKE_EVENT_TYPES.has('ingress_request'));
});
