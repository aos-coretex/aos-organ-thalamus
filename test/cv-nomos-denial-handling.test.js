/**
 * CV: Nomos denial handling.
 *
 * Tests the dispatcher's Nomos OTM consumers:
 *   - Denied ruling -> job DENIED + job_failed ack
 *   - Authorized ruling -> no transition, status awaiting_atm
 *   - Escalate ruling -> logged, no transition
 *   - APM rejected -> job DENIED + job_failed ack
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
  return { forwardAtm: async () => ({ forwarded: true, target: 'Cerberus', execution_request_attached: true }) };
}

function fakeR0Dispatcher() {
  return { dispatchAll: async () => ({ executed: false, results: [], failures: [], total: 0 }) };
}

async function setupWithAwaitingAuthJob(apRef) {
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

  // Create a job and advance to AWAITING_AUTH
  const job = await lifecycle.createJob({
    source: 'cortex',
    originator_ref: 'urn:test:cv-nomos',
    reply_to: 'Cortex',
    priority: 'medium',
    description: 'CV Nomos denial test',
  });

  await lifecycle.markPlanning(job.job_urn);
  await lifecycle.markAwaitingAuth(job.job_urn, {
    ap_ref: apRef,
    risk_tier: 'medium',
    rollback_plan: 'revert',
    targets: ['SafeVault:backup'],
    evidence_refs: [],
    mission_frame_ref: null,
    execution_plan: { targets: ['urn:res:1'], action_type: 'test', credential_name: 'c' },
  });

  return { dispatcher, lifecycle, jobStore, spine, job };
}

test('CV: Denied ruling transitions job to DENIED and emits job_failed ack', async () => {
  const apRef = 'urn:llm-ops:apm:cv-denied-1';
  const { dispatcher, lifecycle, spine, job } = await setupWithAwaitingAuthJob(apRef);

  assert.equal(lifecycle.getJob(job.job_urn).state, 'AWAITING_AUTH');

  const result = await dispatcher.handleAdjudicationResult({
    envelope: {
      payload: {
        ap_ref: apRef,
        ruling: 'Denied',
        reason: 'OUT_OF_SCOPE: violates BoR section 3',
      },
    },
  });

  assert.equal(result.handled, true);
  assert.equal(result.status, 'denied');
  assert.equal(lifecycle.getJob(job.job_urn).state, 'DENIED');
  assert.match(lifecycle.getJob(job.job_urn).denial_reason, /OUT_OF_SCOPE/);

  const failAck = spine.sent.find(e => e.payload?.event_type === 'job_failed');
  assert.ok(failAck, 'job_failed ack must be emitted on Denied ruling');
  assert.equal(failAck.target_organ, 'Cortex');
});

test('CV: Authorized ruling returns awaiting_atm with no state transition', async () => {
  const apRef = 'urn:llm-ops:apm:cv-auth-1';
  const { dispatcher, lifecycle, spine, job } = await setupWithAwaitingAuthJob(apRef);

  const result = await dispatcher.handleAdjudicationResult({
    envelope: {
      payload: {
        ap_ref: apRef,
        ruling: 'Authorized',
      },
    },
  });

  assert.equal(result.handled, true);
  assert.equal(result.status, 'awaiting_atm');

  // Job stays in AWAITING_AUTH — no state change
  assert.equal(lifecycle.getJob(job.job_urn).state, 'AWAITING_AUTH');

  // No lifecycle acks emitted for Authorized (ATM arrival triggers dispatch acks)
  const lifecycleAcks = spine.sent.filter(e => e.type === 'OTM' && e.payload?.event_type);
  assert.equal(lifecycleAcks.length, 0, 'no lifecycle acks on Authorized — ATM does that');
});

test('CV: Escalate ruling is logged, no state transition', async () => {
  const apRef = 'urn:llm-ops:apm:cv-esc-1';
  const { dispatcher, lifecycle, spine, job } = await setupWithAwaitingAuthJob(apRef);

  const result = await dispatcher.handleAdjudicationResult({
    envelope: {
      payload: {
        ap_ref: apRef,
        ruling: 'Escalate',
        per_ref: 'urn:llm-ops:pem:cv-esc-1',
      },
    },
  });

  assert.equal(result.handled, true);
  assert.equal(result.status, 'escalated');

  // Job stays in AWAITING_AUTH — Escalate does not change state
  assert.equal(lifecycle.getJob(job.job_urn).state, 'AWAITING_AUTH');

  // No lifecycle acks on Escalate
  const lifecycleAcks = spine.sent.filter(e => e.type === 'OTM');
  assert.equal(lifecycleAcks.length, 0, 'no lifecycle acks on Escalate');
});

test('CV: APM rejected transitions to DENIED and emits job_failed ack', async () => {
  const apRef = 'urn:llm-ops:apm:cv-rej-1';
  const { dispatcher, lifecycle, spine, job } = await setupWithAwaitingAuthJob(apRef);

  const result = await dispatcher.handleApmRejected({
    envelope: {
      payload: {
        ap_ref: apRef,
        reason: 'source_organ_mismatch',
      },
    },
  });

  assert.equal(result.handled, true);
  assert.equal(lifecycle.getJob(job.job_urn).state, 'DENIED');
  assert.match(lifecycle.getJob(job.job_urn).denial_reason, /nomos_apm_rejected/);

  const failAck = spine.sent.find(e => e.payload?.event_type === 'job_failed');
  assert.ok(failAck, 'job_failed ack must be emitted on APM rejection');
});
