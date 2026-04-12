/**
 * CV: Write-lane end-to-end (unit-style integration).
 *
 * Uses mocks (no real Spine). Creates a job through the lifecycle, enriches
 * it with AP data, dispatches via ATM forwarding, and completes via
 * Cerberus execution_completed broadcast. Validates the full write-lane
 * sequence: CREATED -> PLANNING -> AWAITING_AUTH -> DISPATCHED -> SUCCEEDED.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDispatcher } from '../lib/dispatcher.js';
import { createAtmForwarder } from '../lib/atm-forwarder.js';
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

function fakeR0Dispatcher() {
  return { dispatchAll: async () => ({ executed: false, results: [], failures: [], total: 0 }) };
}

function setup() {
  const spine = fakeSpine();
  const jobStore = createJobStore();
  const lifecycle = createJobLifecycle({ spineStateClient: fakeSpineStateClient(), jobStore });
  const ackEmitter = createLifecycleAckEmitter({ spine });
  const atmForwarder = createAtmForwarder({ spine, jobLifecycle: lifecycle });

  const dispatcher = createDispatcher({
    jobLifecycle: lifecycle,
    atmForwarder,
    r0Dispatcher: fakeR0Dispatcher(),
    lifecycleAckEmitter: ackEmitter,
  });

  return { dispatcher, lifecycle, jobStore, spine, ackEmitter };
}

test('CV: write-lane ATM forwarded, job transitions to DISPATCHED, lifecycle ack emitted', async () => {
  const { dispatcher, lifecycle, jobStore, spine } = setup();

  // Create job and advance through lifecycle
  const job = await lifecycle.createJob({
    source: 'cortex',
    originator_ref: 'urn:test:cv-write-e2e',
    reply_to: 'Cortex',
    priority: 'high',
    description: 'CV write-lane e2e test',
  });

  await lifecycle.markPlanning(job.job_urn);
  await lifecycle.markAwaitingAuth(job.job_urn, {
    ap_ref: 'urn:llm-ops:apm:cv-write-e2e',
    risk_tier: 'medium',
    rollback_plan: 'revert',
    targets: ['SafeVault:backup'],
    evidence_refs: ['urn:llm-ops:radiant:block:1'],
    mission_frame_ref: '1.0.0-seed:1.0.0',
    execution_plan: {
      targets: ['urn:res:1'],
      action_type: 'safevault_backup_run',
      credential_name: 'coretex.cerberus.safevault_writer',
      conditionState: {},
      payload: { backup_set: 'full' },
    },
  });

  const beforeState = jobStore.get(job.job_urn);
  assert.equal(beforeState.state, 'AWAITING_AUTH');

  // Synthesize ATM from Nomos
  const atmEnvelope = {
    type: 'ATM',
    source_organ: 'Nomos',
    target_organ: 'Thalamus',
    payload: {
      token_urn: 'urn:graphheight:authorization_token:cv-write-e2e',
      scope: { action_types: ['safevault_backup_run'] },
      ap_ref: 'urn:llm-ops:apm:cv-write-e2e',
      ruling_ref: 'urn:llm-ops:ruling:cv-write-e2e',
    },
  };

  // Dispatch via ATM arrival
  const result = await dispatcher.dispatchWriteAfterAuth({ atmEnvelope });
  assert.equal(result.dispatched, true);
  assert.equal(result.target, 'Cerberus');

  // Job should be DISPATCHED
  const dispatched = jobStore.get(job.job_urn);
  assert.equal(dispatched.state, 'DISPATCHED');
  assert.equal(dispatched.token_urn, 'urn:graphheight:authorization_token:cv-write-e2e');

  // Spine should have ATM to Cerberus + job_dispatched ack to Cortex
  const atmSent = spine.sent.find(e => e.type === 'ATM' && e.target_organ === 'Cerberus');
  assert.ok(atmSent, 'ATM must be sent to Cerberus');
  const dispatchAck = spine.sent.find(e => e.payload?.event_type === 'job_dispatched');
  assert.ok(dispatchAck, 'job_dispatched ack must be emitted');
});

test('CV: execution_completed via dispatcher completes job to SUCCEEDED', async () => {
  const { dispatcher, lifecycle, jobStore, spine } = setup();

  // Full lifecycle setup
  const job = await lifecycle.createJob({
    source: 'cortex',
    originator_ref: 'urn:test:cv-write-complete',
    reply_to: 'Cortex',
    priority: 'medium',
    description: 'CV write-lane completion test',
  });

  await lifecycle.markPlanning(job.job_urn);
  await lifecycle.markAwaitingAuth(job.job_urn, {
    ap_ref: 'urn:llm-ops:apm:cv-write-complete',
    risk_tier: 'low',
    rollback_plan: 'none',
    targets: ['Engram:ingest'],
    evidence_refs: [],
    mission_frame_ref: null,
    execution_plan: {
      targets: ['urn:doc:1'],
      action_type: 'engram_ingest',
      credential_name: 'coretex.cerberus.engram_writer',
      conditionState: {},
      payload: {},
    },
  });

  // Dispatch via ATM
  const atmEnvelope = {
    type: 'ATM',
    source_organ: 'Nomos',
    payload: {
      token_urn: 'urn:graphheight:authorization_token:cv-write-complete',
      scope: { action_types: ['engram_ingest'] },
      ap_ref: 'urn:llm-ops:apm:cv-write-complete',
      ruling_ref: 'urn:llm-ops:ruling:cv-write-complete',
    },
  };
  await dispatcher.dispatchWriteAfterAuth({ atmEnvelope });
  assert.equal(jobStore.get(job.job_urn).state, 'DISPATCHED');

  // Simulate Cerberus execution_completed broadcast
  const completedEnvelope = {
    source_organ: 'Cerberus',
    payload: {
      event_type: 'execution_completed',
      token_urn: 'urn:graphheight:authorization_token:cv-write-complete',
      execution_id: 'urn:llm-ops:execution:cv-1',
    },
  };
  const completeResult = await dispatcher.handleExecutionCompleted({ envelope: completedEnvelope });
  assert.equal(completeResult.handled, true);

  // Job should be SUCCEEDED
  const final = jobStore.get(job.job_urn);
  assert.equal(final.state, 'SUCCEEDED');

  // job_completed ack must be emitted
  const completedAck = spine.sent.find(e => e.payload?.event_type === 'job_completed');
  assert.ok(completedAck, 'job_completed ack must be emitted');
  assert.equal(completedAck.target_organ, 'Cortex');
});

test('CV: write-lane full sequence creates correct ack count', async () => {
  const { dispatcher, lifecycle, jobStore, spine } = setup();

  const job = await lifecycle.createJob({
    source: 'cortex',
    originator_ref: 'urn:test:cv-ack-count',
    reply_to: 'Cortex',
    priority: 'medium',
    description: 'CV ack count test',
  });

  await lifecycle.markPlanning(job.job_urn);
  await lifecycle.markAwaitingAuth(job.job_urn, {
    ap_ref: 'urn:llm-ops:apm:cv-ack-count',
    risk_tier: 'low',
    rollback_plan: 'none',
    targets: ['Graph:upsert'],
    evidence_refs: [],
    mission_frame_ref: null,
    execution_plan: {
      targets: ['urn:concept:1'],
      action_type: 'graph_concept_upsert',
      credential_name: 'coretex.cerberus.graph_writer',
      conditionState: {},
      payload: {},
    },
  });

  // ATM dispatch
  await dispatcher.dispatchWriteAfterAuth({
    atmEnvelope: {
      type: 'ATM',
      source_organ: 'Nomos',
      payload: {
        token_urn: 'urn:graphheight:authorization_token:cv-ack-count',
        scope: {},
        ap_ref: 'urn:llm-ops:apm:cv-ack-count',
        ruling_ref: 'urn:llm-ops:ruling:cv-ack-count',
      },
    },
  });

  // Execution completed
  await dispatcher.handleExecutionCompleted({
    envelope: {
      source_organ: 'Cerberus',
      payload: {
        event_type: 'execution_completed',
        token_urn: 'urn:graphheight:authorization_token:cv-ack-count',
        execution_id: 'urn:llm-ops:execution:cv-ack',
      },
    },
  });

  // Count OTM acks (exclude the ATM to Cerberus)
  const acks = spine.sent.filter(e => e.type === 'OTM');
  const ackTypes = acks.map(a => a.payload.event_type);
  assert.ok(ackTypes.includes('job_dispatched'), 'must have job_dispatched ack');
  assert.ok(ackTypes.includes('job_completed'), 'must have job_completed ack');
});
