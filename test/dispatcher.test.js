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
  return { sent, send: async (env) => { sent.push(env); return { message_id: 'urn:test:1' }; } };
}

function fakeAtmForwarder({ forwarded = true, error = null } = {}) {
  const calls = [];
  return {
    calls,
    forwardAtm: async (args) => {
      calls.push(args);
      if (!forwarded) return { forwarded: false, error };
      return { forwarded: true, target: 'Cerberus', execution_request_attached: true, forwarded_message_id: 'urn:fwd:1' };
    },
  };
}

function fakeR0Dispatcher({ results = [], failures = [] } = {}) {
  return {
    dispatchAll: async () => ({
      executed: results.length > 0,
      results, failures, total: results.length + failures.length, duration_ms: 10,
    }),
  };
}

async function setupWithJob(overrides = {}) {
  const spine = fakeSpine();
  const jobStore = createJobStore();
  const lifecycle = createJobLifecycle({ spineStateClient: fakeSpineStateClient(), jobStore });
  const ackEmitter = createLifecycleAckEmitter({ spine });

  // Create and advance a job
  const job = await lifecycle.createJob({ source: 'cortex', originator_ref: 'urn:test', reply_to: 'Cortex', priority: 'medium', description: 'test' });
  await lifecycle.markPlanning(job.job_urn);

  // Enrich with ap_ref for write-lane lookup
  if (overrides.ap_ref) {
    jobStore.update(job.job_urn, { ap_ref: overrides.ap_ref, lane: overrides.lane || 'write', execution_plan: overrides.execution_plan || { targets: ['urn:r:1'], action_type: 'test', credential_name: 'c' } });
  }
  if (overrides.lane === 'r0') {
    jobStore.update(job.job_urn, { lane: 'r0' });
  }

  const dispatcher = createDispatcher({
    jobLifecycle: lifecycle,
    atmForwarder: overrides.atmForwarder || fakeAtmForwarder(),
    r0Dispatcher: overrides.r0Dispatcher || fakeR0Dispatcher({ results: [{ target: 'R:q', ok: true, data: {} }] }),
    lifecycleAckEmitter: ackEmitter,
  });

  return { dispatcher, lifecycle, jobStore, spine, job };
}

test('dispatchWriteAfterAuth happy path: ATM forwarded + job_dispatched ack', async () => {
  const { dispatcher, spine, job } = await setupWithJob({ ap_ref: 'urn:llm-ops:apm:test', lane: 'write' });
  // Also need to transition to AWAITING_AUTH for the forwarder's markDispatched to work
  const atm = { type: 'ATM', source_organ: 'Nomos', payload: { ap_ref: 'urn:llm-ops:apm:test', token_urn: 'urn:token:1', scope: {}, ruling_ref: 'urn:r:1' } };
  const result = await dispatcher.dispatchWriteAfterAuth({ atmEnvelope: atm });
  assert.equal(result.dispatched, true);
  assert.ok(spine.sent.some(e => e.payload.event_type === 'job_dispatched'));
});

test('dispatchWriteAfterAuth no ap_ref -> error', async () => {
  const { dispatcher } = await setupWithJob({ ap_ref: 'urn:apm:1' });
  const result = await dispatcher.dispatchWriteAfterAuth({ atmEnvelope: { type: 'ATM', payload: {} } });
  assert.equal(result.dispatched, false);
  assert.equal(result.error, 'no_ap_ref_in_atm');
});

test('dispatchWriteAfterAuth no matching job -> error', async () => {
  const { dispatcher } = await setupWithJob({ ap_ref: 'urn:apm:1' });
  const atm = { type: 'ATM', payload: { ap_ref: 'urn:apm:nonexistent', token_urn: 't', scope: {}, ruling_ref: 'r' } };
  const result = await dispatcher.dispatchWriteAfterAuth({ atmEnvelope: atm });
  assert.equal(result.dispatched, false);
  assert.equal(result.error, 'job_not_found_for_ap_ref');
});

test('dispatchWriteAfterAuth forwarder fails -> DENIED + job_failed ack', async () => {
  const { dispatcher, lifecycle, spine, job } = await setupWithJob({
    ap_ref: 'urn:apm:fwd-fail',
    atmForwarder: fakeAtmForwarder({ forwarded: false, error: 'execution_plan_missing' }),
  });
  // Advance to AWAITING_AUTH (the state when ATM arrives)
  await lifecycle.markAwaitingAuth(job.job_urn, { ap_ref: 'urn:apm:fwd-fail', risk_tier: 'medium', rollback_plan: 'r', targets: [], evidence_refs: [], mission_frame_ref: null, execution_plan: null });
  const atm = { type: 'ATM', payload: { ap_ref: 'urn:apm:fwd-fail', token_urn: 't', scope: {}, ruling_ref: 'r' } };
  const result = await dispatcher.dispatchWriteAfterAuth({ atmEnvelope: atm });
  assert.equal(result.dispatched, false);
  assert.equal(lifecycle.getJob(job.job_urn).state, 'DENIED');
  assert.ok(spine.sent.some(e => e.payload.event_type === 'job_failed'));
});

test('dispatchR0 happy path: all targets succeed -> SUCCEEDED + acks', async () => {
  const { dispatcher, lifecycle, spine, job } = await setupWithJob({ lane: 'r0' });
  const result = await dispatcher.dispatchR0({ jobRecord: lifecycle.getJob(job.job_urn), targets: ['Radiant:query'] });
  assert.equal(result.dispatched, true);
  assert.equal(result.completed, true);
  assert.equal(lifecycle.getJob(job.job_urn).state, 'SUCCEEDED');
  assert.ok(spine.sent.some(e => e.payload.event_type === 'job_dispatched'));
  assert.ok(spine.sent.some(e => e.payload.event_type === 'job_completed'));
});

test('dispatchR0 all-fail -> FAILED + job_failed ack', async () => {
  const { dispatcher, lifecycle, spine, job } = await setupWithJob({
    lane: 'r0',
    r0Dispatcher: fakeR0Dispatcher({ results: [], failures: [{ target: 'X:q', ok: false, error: 'timeout' }] }),
  });
  const result = await dispatcher.dispatchR0({ jobRecord: lifecycle.getJob(job.job_urn), targets: ['X:q'] });
  assert.equal(result.completed, false);
  assert.equal(lifecycle.getJob(job.job_urn).state, 'FAILED');
  assert.ok(spine.sent.some(e => e.payload.event_type === 'job_failed'));
});

test('dispatchR0 wrong lane -> error', async () => {
  const { dispatcher, lifecycle, job } = await setupWithJob({ lane: 'write', ap_ref: 'urn:apm:1' });
  const result = await dispatcher.dispatchR0({ jobRecord: lifecycle.getJob(job.job_urn), targets: [] });
  assert.equal(result.dispatched, false);
  assert.equal(result.error, 'lane_not_r0');
});

test('handleAdjudicationResult Authorized -> awaiting_atm', async () => {
  const { dispatcher } = await setupWithJob({ ap_ref: 'urn:apm:adj-test' });
  const result = await dispatcher.handleAdjudicationResult({ envelope: { payload: { ap_ref: 'urn:apm:adj-test', ruling: 'Authorized' } } });
  assert.equal(result.status, 'awaiting_atm');
});

test('handleAdjudicationResult Denied -> DENIED + job_failed', async () => {
  const { dispatcher, lifecycle, spine, job } = await setupWithJob({ ap_ref: 'urn:apm:deny-test' });
  // Need AWAITING_AUTH for markDenied
  await lifecycle.markAwaitingAuth(job.job_urn, { ap_ref: 'urn:apm:deny-test', risk_tier: 'medium', rollback_plan: 'r', targets: [], evidence_refs: [], mission_frame_ref: null, execution_plan: null });
  const result = await dispatcher.handleAdjudicationResult({ envelope: { payload: { ap_ref: 'urn:apm:deny-test', ruling: 'Denied', reason: 'out of scope' } } });
  assert.equal(result.status, 'denied');
  assert.equal(lifecycle.getJob(job.job_urn).state, 'DENIED');
  assert.ok(spine.sent.some(e => e.payload.event_type === 'job_failed'));
});

test('handleAdjudicationResult Escalate -> escalated, no transition', async () => {
  const { dispatcher } = await setupWithJob({ ap_ref: 'urn:apm:esc' });
  const result = await dispatcher.handleAdjudicationResult({ envelope: { payload: { ap_ref: 'urn:apm:esc', ruling: 'Escalate', per_ref: 'urn:pem:1' } } });
  assert.equal(result.status, 'escalated');
});

test('handleAdjudicationHeld -> held, no transition', async () => {
  const { dispatcher } = await setupWithJob({ ap_ref: 'urn:apm:held' });
  const result = await dispatcher.handleAdjudicationHeld({ envelope: { payload: { ap_ref: 'urn:apm:held', missing_evidence: ['x'] } } });
  assert.equal(result.status, 'held');
});

test('handleApmRejected -> DENIED + job_failed ack', async () => {
  const { dispatcher, lifecycle, job } = await setupWithJob({ ap_ref: 'urn:apm:rej' });
  // Advance to AWAITING_AUTH (the state when Nomos rejects an APM)
  await lifecycle.markAwaitingAuth(job.job_urn, { ap_ref: 'urn:apm:rej', risk_tier: 'medium', rollback_plan: 'r', targets: [], evidence_refs: [], mission_frame_ref: null, execution_plan: null });
  const result = await dispatcher.handleApmRejected({ envelope: { payload: { ap_ref: 'urn:apm:rej', reason: 'wrong_source' } } });
  assert.equal(result.handled, true);
  assert.equal(lifecycle.getJob(job.job_urn).state, 'DENIED');
});

test('handleExecutionCompleted matching token -> SUCCEEDED + job_completed', async () => {
  const { dispatcher, lifecycle, spine, job } = await setupWithJob({ ap_ref: 'urn:apm:exec', lane: 'write' });
  // Simulate AWAITING_AUTH -> DISPATCHED -> EXECUTING flow
  await lifecycle.markAwaitingAuth(job.job_urn, { ap_ref: 'urn:apm:exec', risk_tier: 'medium', rollback_plan: 'r', targets: [], evidence_refs: [], mission_frame_ref: null, execution_plan: null });
  await lifecycle.markDispatched(job.job_urn, { token_urn: 'urn:token:exec', target_organs: ['Cerberus'] });
  const result = await dispatcher.handleExecutionCompleted({ envelope: { source_organ: 'Cerberus', payload: { event_type: 'execution_completed', token_urn: 'urn:token:exec', execution_id: 'urn:exec:1' } } });
  assert.equal(result.handled, true);
  assert.equal(lifecycle.getJob(job.job_urn).state, 'SUCCEEDED');
  assert.ok(spine.sent.some(e => e.payload.event_type === 'job_completed'));
});

test('handleExecutionCompleted non-matching token -> not_our_token', async () => {
  const { dispatcher } = await setupWithJob({});
  const result = await dispatcher.handleExecutionCompleted({ envelope: { source_organ: 'Cerberus', payload: { event_type: 'execution_completed', token_urn: 'urn:token:foreign' } } });
  assert.equal(result.handled, false);
  assert.equal(result.reason, 'not_our_token');
});

test('handleExecutionDenied -> FAILED + job_failed', async () => {
  const { dispatcher, lifecycle, job } = await setupWithJob({ ap_ref: 'urn:apm:d', lane: 'write' });
  await lifecycle.markAwaitingAuth(job.job_urn, { ap_ref: 'urn:apm:d', risk_tier: 'medium', rollback_plan: 'r', targets: [], evidence_refs: [], mission_frame_ref: null, execution_plan: null });
  await lifecycle.markDispatched(job.job_urn, { token_urn: 'urn:token:d', target_organs: ['Cerberus'] });
  const result = await dispatcher.handleExecutionDenied({ envelope: { source_organ: 'Cerberus', payload: { event_type: 'execution_denied', token_urn: 'urn:token:d', reason: 'scope_mismatch' } } });
  assert.equal(result.handled, true);
  assert.equal(lifecycle.getJob(job.job_urn).state, 'FAILED');
});

test('handleExecutionFailed (rollforward) -> FAILED + job_failed', async () => {
  const { dispatcher, lifecycle, job } = await setupWithJob({ ap_ref: 'urn:apm:rf', lane: 'write' });
  await lifecycle.markAwaitingAuth(job.job_urn, { ap_ref: 'urn:apm:rf', risk_tier: 'medium', rollback_plan: 'r', targets: [], evidence_refs: [], mission_frame_ref: null, execution_plan: null });
  await lifecycle.markDispatched(job.job_urn, { token_urn: 'urn:token:rf', target_organs: ['Cerberus'] });
  const result = await dispatcher.handleExecutionFailed({ envelope: { source_organ: 'Cerberus', payload: { event_type: 'execution_failed', token_urn: 'urn:token:rf' } } });
  assert.equal(result.handled, true);
  assert.equal(lifecycle.getJob(job.job_urn).state, 'FAILED');
});
