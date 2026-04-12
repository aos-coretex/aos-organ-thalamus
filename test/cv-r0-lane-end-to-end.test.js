/**
 * CV: R0-lane end-to-end (unit-style).
 *
 * Uses mocks (no real Spine or department organs). Creates a job, sets
 * lane='r0', dispatches via the R0 fast path, and verifies:
 *   - state transitions: PLANNING -> DISPATCHED -> EXECUTING -> SUCCEEDED
 *   - lifecycle acks emitted (job_dispatched, job_completed)
 *   - no APM sent to Nomos
 *   - no ATM forwarded to Cerberus
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDispatcher } from '../lib/dispatcher.js';
import { createJobLifecycle } from '../lib/job-lifecycle.js';
import { createJobStore } from '../lib/job-store.js';
import { createLifecycleAckEmitter } from '../lib/lifecycle-ack-emitter.js';

function fakeSpineStateClient() {
  return {
    createJobEntity: async (urn) => ({ entity_urn: urn }),
    transitionJob: async () => ({}),
    getJobEntity: async () => null,
    listNonTerminalJobs: async () => [],
  };
}

function fakeSpine() {
  const sent = [];
  return { sent, send: async (env) => { sent.push(env); return { message_id: 'urn:test:cv' }; } };
}

function fakeAtmForwarder() {
  const calls = [];
  return {
    calls,
    forwardAtm: async (args) => {
      calls.push(args);
      return { forwarded: true, target: 'Cerberus', execution_request_attached: true, forwarded_message_id: 'urn:fwd:cv' };
    },
  };
}

function fakeR0Dispatcher({ results = [], failures = [] } = {}) {
  const calls = [];
  return {
    calls,
    dispatchAll: async (jobRecord, targets) => {
      calls.push({ jobRecord, targets });
      return {
        executed: results.length > 0,
        results,
        failures,
        total: results.length + failures.length,
        duration_ms: 5,
      };
    },
  };
}

function setup({ r0Results = [{ target: 'Radiant:query', ok: true, data: {} }] } = {}) {
  const spine = fakeSpine();
  const jobStore = createJobStore();
  const lifecycle = createJobLifecycle({ spineStateClient: fakeSpineStateClient(), jobStore });
  const ackEmitter = createLifecycleAckEmitter({ spine });
  const atmFwd = fakeAtmForwarder();
  const r0Disp = fakeR0Dispatcher({ results: r0Results });

  const dispatcher = createDispatcher({
    jobLifecycle: lifecycle,
    atmForwarder: atmFwd,
    r0Dispatcher: r0Disp,
    lifecycleAckEmitter: ackEmitter,
  });

  return { dispatcher, lifecycle, jobStore, spine, atmFwd, r0Disp };
}

test('CV: R0 dispatch transitions PLANNING->DISPATCHED->EXECUTING->SUCCEEDED', async () => {
  const { dispatcher, lifecycle, jobStore } = setup();

  const job = await lifecycle.createJob({
    source: 'cortex',
    originator_ref: 'urn:test:cv-r0-e2e',
    reply_to: 'Cortex',
    priority: 'medium',
    description: 'CV R0 lane e2e test',
  });

  await lifecycle.markPlanning(job.job_urn);
  lifecycle.setLane(job.job_urn, 'r0');

  const jobRecord = jobStore.get(job.job_urn);
  assert.equal(jobRecord.state, 'PLANNING');
  assert.equal(jobRecord.lane, 'r0');

  const result = await dispatcher.dispatchR0({
    jobRecord,
    targets: ['Radiant:query'],
  });

  assert.equal(result.dispatched, true);
  assert.equal(result.completed, true);

  const final = jobStore.get(job.job_urn);
  assert.equal(final.state, 'SUCCEEDED');
  assert.ok(final.result, 'result must be set on SUCCEEDED');
  assert.equal(final.result.results.length, 1);
});

test('CV: R0 dispatch emits job_dispatched and job_completed acks, no APM or ATM', async () => {
  const { dispatcher, lifecycle, jobStore, spine, atmFwd } = setup();

  const job = await lifecycle.createJob({
    source: 'cortex',
    originator_ref: 'urn:test:cv-r0-acks',
    reply_to: 'Cortex',
    priority: 'low',
    description: 'CV R0 ack verification',
  });

  await lifecycle.markPlanning(job.job_urn);
  lifecycle.setLane(job.job_urn, 'r0');

  await dispatcher.dispatchR0({
    jobRecord: jobStore.get(job.job_urn),
    targets: ['Radiant:query'],
  });

  // Must have lifecycle acks
  const ackTypes = spine.sent.map(e => e.payload?.event_type).filter(Boolean);
  assert.ok(ackTypes.includes('job_dispatched'), 'must emit job_dispatched');
  assert.ok(ackTypes.includes('job_completed'), 'must emit job_completed');

  // No APM sent to Nomos
  const apmMessages = spine.sent.filter(e => e.type === 'APM');
  assert.equal(apmMessages.length, 0, 'R0 lane must not produce APM to Nomos');

  // No ATM forwarded to Cerberus
  assert.equal(atmFwd.calls.length, 0, 'R0 lane must not forward ATM to Cerberus');
});

test('CV: R0 dispatch with all-fail transitions to FAILED with job_failed ack', async () => {
  const { dispatcher, lifecycle, jobStore, spine } = setup({
    r0Results: [],
  });

  // Override the r0Dispatcher to return failures
  const failR0 = fakeR0Dispatcher({
    results: [],
    failures: [{ target: 'Radiant:query', ok: false, error: 'organ_unreachable' }],
  });
  const failDispatcher = createDispatcher({
    jobLifecycle: lifecycle,
    atmForwarder: fakeAtmForwarder(),
    r0Dispatcher: failR0,
    lifecycleAckEmitter: createLifecycleAckEmitter({ spine }),
  });

  const job = await lifecycle.createJob({
    source: 'cortex',
    originator_ref: 'urn:test:cv-r0-fail',
    reply_to: 'Cortex',
    priority: 'medium',
    description: 'CV R0 all-fail test',
  });

  await lifecycle.markPlanning(job.job_urn);
  lifecycle.setLane(job.job_urn, 'r0');

  const result = await failDispatcher.dispatchR0({
    jobRecord: jobStore.get(job.job_urn),
    targets: ['Radiant:query'],
  });

  assert.equal(result.dispatched, true);
  assert.equal(result.completed, false);
  assert.equal(jobStore.get(job.job_urn).state, 'FAILED');

  const failAck = spine.sent.find(e => e.payload?.event_type === 'job_failed');
  assert.ok(failAck, 'must emit job_failed ack on all-fail');
});
