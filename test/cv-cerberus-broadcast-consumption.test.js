/**
 * CV: Cerberus broadcast consumption.
 *
 * Tests dispatcher handling of Cerberus execution broadcasts:
 *   - execution_completed -> job SUCCEEDED + job_completed ack
 *   - execution_denied -> job FAILED + job_failed ack
 *   - execution_failed (rollforward) -> job FAILED + job_failed ack
 *
 * All tests start from DISPATCHED state (the state a write-lane job is in
 * after ATM forwarding to Cerberus).
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
  return { forwardAtm: async () => ({ forwarded: true }) };
}

function fakeR0Dispatcher() {
  return { dispatchAll: async () => ({ executed: false, results: [], failures: [], total: 0 }) };
}

async function setupWithDispatchedJob(tokenUrn) {
  const spine = fakeSpine();
  const jobStore = createJobStore();
  const lifecycle = createJobLifecycle({ spineStateClient: fakeSpineStateClient(), jobStore });
  const ackEmitter = createLifecycleAckEmitter({ spine });

  const dispatcher = createDispatcher({
    jobLifecycle: lifecycle,
    atmForwarder: fakeAtmForwarder(),
    r0Dispatcher: fakeR0Dispatcher(),
    lifecycleAckEmitter: ackEmitter,
  });

  // Create job and advance to DISPATCHED with token_urn set
  const job = await lifecycle.createJob({
    source: 'cortex',
    originator_ref: 'urn:test:cv-cerberus',
    reply_to: 'Cortex',
    priority: 'medium',
    description: 'CV Cerberus broadcast test',
  });

  await lifecycle.markPlanning(job.job_urn);
  await lifecycle.markAwaitingAuth(job.job_urn, {
    ap_ref: `urn:llm-ops:apm:cv-cerberus-${tokenUrn}`,
    risk_tier: 'medium',
    rollback_plan: 'revert',
    targets: ['Graph:upsert'],
    evidence_refs: [],
    mission_frame_ref: null,
    execution_plan: { targets: ['urn:res:1'], action_type: 'test', credential_name: 'c' },
  });
  await lifecycle.markDispatched(job.job_urn, { token_urn: tokenUrn, target_organs: ['Cerberus'] });

  assert.equal(jobStore.get(job.job_urn).state, 'DISPATCHED');

  return { dispatcher, lifecycle, jobStore, spine, job };
}

test('CV: execution_completed -> job SUCCEEDED + job_completed ack', async () => {
  const tokenUrn = 'urn:graphheight:authorization_token:cv-cerberus-ok';
  const { dispatcher, lifecycle, spine, job } = await setupWithDispatchedJob(tokenUrn);

  const result = await dispatcher.handleExecutionCompleted({
    envelope: {
      source_organ: 'Cerberus',
      payload: {
        event_type: 'execution_completed',
        token_urn: tokenUrn,
        execution_id: 'urn:llm-ops:execution:cv-cerberus-1',
      },
    },
  });

  assert.equal(result.handled, true);
  assert.equal(lifecycle.getJob(job.job_urn).state, 'SUCCEEDED');

  const completedAck = spine.sent.find(e => e.payload?.event_type === 'job_completed');
  assert.ok(completedAck, 'job_completed ack must be emitted');
  assert.equal(completedAck.target_organ, 'Cortex');
  assert.equal(completedAck.payload.job_id, job.job_urn);
});

test('CV: execution_denied -> job FAILED + job_failed ack', async () => {
  const tokenUrn = 'urn:graphheight:authorization_token:cv-cerberus-denied';
  const { dispatcher, lifecycle, spine, job } = await setupWithDispatchedJob(tokenUrn);

  const result = await dispatcher.handleExecutionDenied({
    envelope: {
      source_organ: 'Cerberus',
      payload: {
        event_type: 'execution_denied',
        token_urn: tokenUrn,
        reason: 'scope_mismatch',
      },
    },
  });

  assert.equal(result.handled, true);
  assert.equal(lifecycle.getJob(job.job_urn).state, 'FAILED');
  assert.match(lifecycle.getJob(job.job_urn).error, /cerberus_denied/);

  const failAck = spine.sent.find(e => e.payload?.event_type === 'job_failed');
  assert.ok(failAck, 'job_failed ack must be emitted');
  assert.equal(failAck.target_organ, 'Cortex');
});

test('CV: execution_failed (rollforward) -> job FAILED + job_failed ack', async () => {
  const tokenUrn = 'urn:graphheight:authorization_token:cv-cerberus-rollforward';
  const { dispatcher, lifecycle, spine, job } = await setupWithDispatchedJob(tokenUrn);

  const result = await dispatcher.handleExecutionFailed({
    envelope: {
      source_organ: 'Cerberus',
      payload: {
        event_type: 'execution_failed',
        token_urn: tokenUrn,
      },
    },
  });

  assert.equal(result.handled, true);
  assert.equal(lifecycle.getJob(job.job_urn).state, 'FAILED');
  assert.match(lifecycle.getJob(job.job_urn).error, /cerberus_rollforward/);

  const failAck = spine.sent.find(e => e.payload?.event_type === 'job_failed');
  assert.ok(failAck, 'job_failed ack must be emitted on rollforward');
});
