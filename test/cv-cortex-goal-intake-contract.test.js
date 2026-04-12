/**
 * CV: Cortex goal intake contract (INVERSE CONTRACT LOCK).
 *
 * Consumes the canonical Cortex envelope from fixtures and feeds it through
 * createGoalIntake. Asserts the inverse of the Cortex-side contract:
 *   - handled=true
 *   - JobRecord created with source='cortex'
 *   - lifecycle ack emitted to Cortex
 *   - intake_context preserves cortex_iteration, severity, source_category
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeCanonicalCortexEnvelope } from './fixtures/canonical-cortex-envelope.js';
import { createGoalIntake } from '../lib/goal-intake.js';
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

function setup() {
  const spine = fakeSpine();
  const jobStore = createJobStore();
  const lifecycle = createJobLifecycle({ spineStateClient: fakeSpineStateClient(), jobStore });
  const ackEmitter = createLifecycleAckEmitter({ spine });
  const goalIntake = createGoalIntake({ jobLifecycle: lifecycle, lifecycleAckEmitter: ackEmitter });
  return { goalIntake, jobStore, spine, lifecycle };
}

test('CV: canonical Cortex envelope produces handled=true with source=cortex', async () => {
  const { goalIntake, jobStore } = setup();
  const env = makeCanonicalCortexEnvelope();
  const result = await goalIntake(env);

  assert.equal(result.handled, true);
  assert.match(result.job_urn, /^urn:llm-ops:job:/);

  const job = jobStore.get(result.job_urn);
  assert.equal(job.source, 'cortex');
  assert.equal(job.state, 'CREATED');
  assert.equal(job.priority, 'high');
  assert.equal(job.reply_to, 'Cortex');
  assert.equal(job.originator_ref, env.message_id);
});

test('CV: lifecycle ack emitted to Cortex with job_record_created', async () => {
  const { goalIntake, spine, jobStore } = setup();
  const env = makeCanonicalCortexEnvelope();
  const result = await goalIntake(env);

  assert.equal(spine.sent.length, 1, 'exactly one lifecycle ack must be emitted');
  const ack = spine.sent[0];
  assert.equal(ack.type, 'OTM');
  assert.equal(ack.source_organ, 'Thalamus');
  assert.equal(ack.target_organ, 'Cortex');
  assert.equal(ack.payload.event_type, 'job_record_created');
  assert.equal(ack.payload.job_id, result.job_urn);

  const job = jobStore.get(result.job_urn);
  assert.equal(ack.payload.originator_ref, job.originator_ref);
});

test('CV: intake_context preserves cortex_iteration, severity, source_category', async () => {
  const { goalIntake, jobStore } = setup();
  const env = makeCanonicalCortexEnvelope();
  const result = await goalIntake(env);

  const job = jobStore.get(result.job_urn);
  assert.equal(job.intake_context.kind, 'cortex_goal');
  assert.equal(job.intake_context.cortex_iteration, 7);
  assert.equal(job.intake_context.severity, 0.85);
  assert.equal(job.intake_context.source_category, 'operational');
  assert.equal(job.intake_context.goal_id, env.payload.goal_id);
  assert.equal(job.intake_context.gap_ref, env.payload.gap_ref);
  assert.equal(job.intake_context.target_state, env.payload.target_state);
});

test('CV: assessment_context carried through from Cortex envelope', async () => {
  const { goalIntake, jobStore } = setup();
  const env = makeCanonicalCortexEnvelope();
  const result = await goalIntake(env);

  const job = jobStore.get(result.job_urn);
  assert.ok(job.assessment_context, 'assessment_context must be set');
  assert.equal(job.assessment_context.msp_version, '1.0.0-seed');
  assert.equal(job.assessment_context.msp_hash, 'msp-known-hash');
  assert.equal(job.assessment_context.bor_version, '1.0.0');
  assert.equal(job.assessment_context.bor_hash, 'bor-known-hash');
  assert.equal(job.assessment_context.cortex_iteration, 7);
  assert.equal(job.assessment_context.assessed_at, '2026-04-11T12:00:00Z');
});
