import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGoalIntake } from '../lib/goal-intake.js';
import { createJobLifecycle } from '../lib/job-lifecycle.js';
import { createJobStore } from '../lib/job-store.js';
import { createLifecycleAckEmitter } from '../lib/lifecycle-ack-emitter.js';

// Lifted from AOS-organ-cortex-src/test/cv-goal-delivery.test.js KNOWN_GAP +
// the goal-emitter buildEnvelope shape. Any drift between this fixture and
// the Cortex test indicates a contract drift — fix the producer side first.
function makeCanonicalCortexEnvelope() {
  return {
    type: 'OTM',
    source_organ: 'Cortex',
    target_organ: 'Thalamus',
    reply_to: 'Cortex',
    message_id: 'urn:llm-ops:otm:test-cortex-1',
    payload: {
      event_type: 'autonomous_goal',
      goal_id: 'urn:llm-ops:goal:1744380000000-0-known1',
      gap_ref: 'urn:llm-ops:cortex-gap:1744380000000-0-known1',
      description: 'known test gap — backups have not run in 8 days',
      target_state: 'Daily backup cycle resumed',
      priority: 'high',
      mission_ref: 'MSP §Operational Continuity',
      evidence_refs: ['urn:llm-ops:radiant:block:42', 'urn:llm-ops:spine:transition:99'],
      severity: 0.85,
      source_category: 'operational',
      assessment_context: {
        msp_version: '1.0.0-seed',
        msp_hash: 'msp-known-hash',
        bor_version: '1.0.0',
        bor_hash: 'bor-known-hash',
        assessed_at: '2026-04-11T12:00:00Z',
        cortex_iteration: 7,
      },
      deadline_context: null,
      suggested_approach: null,
    },
  };
}

function makeFakeSpine() {
  const sent = [];
  return {
    sent,
    send: async (env) => { sent.push(env); return { message_id: 'urn:test:1' }; },
  };
}

function fakeSpineStateClient() {
  const calls = [];
  return {
    calls,
    createJobEntity: async (urn, md) => { calls.push({ op: 'create', urn, md }); return { entity_urn: urn }; },
    transitionJob: async () => ({}),
    getJobEntity: async () => null,
    listNonTerminalJobs: async () => [],
  };
}

function setup() {
  const spine = makeFakeSpine();
  const ssClient = fakeSpineStateClient();
  const jobStore = createJobStore();
  const lifecycle = createJobLifecycle({ spineStateClient: ssClient, jobStore });
  const ackEmitter = createLifecycleAckEmitter({ spine });
  const goalIntake = createGoalIntake({ jobLifecycle: lifecycle, lifecycleAckEmitter: ackEmitter });
  return { goalIntake, lifecycle, jobStore, spine, ssClient };
}

test('canonical Cortex envelope creates a job and emits job_record_created', async () => {
  const { goalIntake, jobStore, spine } = setup();
  const env = makeCanonicalCortexEnvelope();
  const result = await goalIntake(env);

  assert.equal(result.handled, true);
  assert.match(result.job_urn, /^urn:llm-ops:job:/);
  assert.equal(jobStore.size(), 1);

  const job = jobStore.get(result.job_urn);
  assert.equal(job.source, 'cortex');
  assert.equal(job.priority, 'high');
  assert.equal(job.description, env.payload.description);
  assert.equal(job.reply_to, 'Cortex');
  assert.equal(job.intake_context.kind, 'cortex_goal');
  assert.equal(job.intake_context.cortex_iteration, 7);
  assert.equal(job.assessment_context.msp_version, '1.0.0-seed');
  assert.deepEqual(job.evidence_refs, env.payload.evidence_refs);

  assert.equal(spine.sent.length, 1, 'lifecycle ack must be emitted');
  const ack = spine.sent[0];
  assert.equal(ack.type, 'OTM');
  assert.equal(ack.source_organ, 'Thalamus');
  assert.equal(ack.target_organ, 'Cortex');
  assert.equal(ack.payload.event_type, 'job_record_created');
  assert.equal(ack.payload.job_id, job.job_urn);
});

test('rejects envelope with wrong source_organ', async () => {
  const { goalIntake } = setup();
  const env = makeCanonicalCortexEnvelope();
  env.source_organ = 'Receptor';
  const result = await goalIntake(env);
  assert.equal(result.handled, false);
  assert.equal(result.error, 'wrong_source_organ');
});

test('rejects envelope with wrong event_type', async () => {
  const { goalIntake } = setup();
  const env = makeCanonicalCortexEnvelope();
  env.payload.event_type = 'health_check';
  const result = await goalIntake(env);
  assert.equal(result.handled, false);
  assert.equal(result.error, 'wrong_event_type');
});

test('rejects envelope with missing goal_id', async () => {
  const { goalIntake } = setup();
  const env = makeCanonicalCortexEnvelope();
  delete env.payload.goal_id;
  const result = await goalIntake(env);
  assert.equal(result.handled, false);
  assert.equal(result.error, 'invalid_goal_id');
});

test('rejects envelope with non-URN goal_id', async () => {
  const { goalIntake } = setup();
  const env = makeCanonicalCortexEnvelope();
  env.payload.goal_id = 'not-a-urn';
  const result = await goalIntake(env);
  assert.equal(result.handled, false);
  assert.equal(result.error, 'invalid_goal_id');
});

test('rejects envelope with missing description', async () => {
  const { goalIntake } = setup();
  const env = makeCanonicalCortexEnvelope();
  env.payload.description = '';
  const result = await goalIntake(env);
  assert.equal(result.handled, false);
  assert.equal(result.error, 'missing_description');
});

test('normalizes invalid priority to medium', async () => {
  const { goalIntake, jobStore } = setup();
  const env = makeCanonicalCortexEnvelope();
  env.payload.priority = 'urgent'; // not in valid set
  const result = await goalIntake(env);
  assert.equal(result.handled, true);
  assert.equal(jobStore.get(result.job_urn).priority, 'medium');
});

test('lifecycle ack is best-effort — spine.send failure does not break intake', async () => {
  const failingSpine = { send: async () => { throw new Error('spine_offline'); } };
  const ssClient = fakeSpineStateClient();
  const jobStore = createJobStore();
  const lifecycle = createJobLifecycle({ spineStateClient: ssClient, jobStore });
  const ackEmitter = createLifecycleAckEmitter({ spine: failingSpine });
  const goalIntake = createGoalIntake({ jobLifecycle: lifecycle, lifecycleAckEmitter: ackEmitter });
  const env = makeCanonicalCortexEnvelope();
  const result = await goalIntake(env);
  assert.equal(result.handled, true, 'intake must succeed even if ack dispatch fails');
  assert.equal(jobStore.size(), 1);
});

test('intake_context preserves all Cortex enrichments verbatim', async () => {
  const { goalIntake, jobStore } = setup();
  const env = makeCanonicalCortexEnvelope();
  env.payload.deadline_context = { deadline: '2026-04-30' };
  env.payload.suggested_approach = 'incremental rsync';
  const result = await goalIntake(env);
  const job = jobStore.get(result.job_urn);
  assert.deepEqual(job.intake_context.deadline_context, { deadline: '2026-04-30' });
  assert.equal(job.intake_context.suggested_approach, 'incremental rsync');
  assert.equal(job.intake_context.severity, 0.85);
  assert.equal(job.intake_context.source_category, 'operational');
});

test('rejects malformed envelope (no payload)', async () => {
  const { goalIntake } = setup();
  const result = await goalIntake({ type: 'OTM', source_organ: 'Cortex' });
  assert.equal(result.handled, false);
  assert.equal(result.error, 'malformed_envelope');
});
