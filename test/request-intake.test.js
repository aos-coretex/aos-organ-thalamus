import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequestIntake } from '../lib/request-intake.js';
import { createJobLifecycle } from '../lib/job-lifecycle.js';
import { createJobStore } from '../lib/job-store.js';
import { createLifecycleAckEmitter } from '../lib/lifecycle-ack-emitter.js';

function makeCanonicalReceptorEnvelope() {
  return {
    type: 'OTM',
    source_organ: 'Receptor',
    target_organ: 'Thalamus',
    reply_to: 'Receptor',
    message_id: 'urn:llm-ops:otm:test-receptor-1',
    payload: {
      event_type: 'ingress_request',
      payload_urn: 'urn:llm-ops:payload:test-1',
      intent_urn: 'urn:llm-ops:intent:question',
      intent_label: 'question',
      channel: 'axon',
      session_id: 'urn:llm-ops:session:test-1',
      user_identity: 'urn:llm-ops:user:leon',
      message: { text: 'how many backups ran today?' },
      classification_confidence: 0.92,
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
  return {
    createJobEntity: async (urn) => ({ entity_urn: urn }),
    transitionJob: async () => ({}),
    getJobEntity: async () => null,
    listNonTerminalJobs: async () => [],
  };
}

function setup() {
  const spine = makeFakeSpine();
  const jobStore = createJobStore();
  const lifecycle = createJobLifecycle({ spineStateClient: fakeSpineStateClient(), jobStore });
  const ackEmitter = createLifecycleAckEmitter({ spine });
  const requestIntake = createRequestIntake({ jobLifecycle: lifecycle, lifecycleAckEmitter: ackEmitter });
  return { requestIntake, lifecycle, jobStore, spine };
}

test('canonical Receptor envelope creates a job with source=receptor and priority=medium (question)', async () => {
  const { requestIntake, jobStore, spine } = setup();
  const env = makeCanonicalReceptorEnvelope();
  const result = await requestIntake(env);

  assert.equal(result.handled, true);
  assert.match(result.job_urn, /^urn:llm-ops:job:/);
  assert.equal(jobStore.size(), 1);

  const job = jobStore.get(result.job_urn);
  assert.equal(job.source, 'receptor');
  assert.equal(job.priority, 'medium');
  assert.equal(job.reply_to, 'Receptor');
  assert.equal(job.intake_context.kind, 'receptor_request');
  assert.equal(job.intake_context.channel, 'axon');

  assert.equal(spine.sent.length, 1);
  assert.equal(spine.sent[0].target_organ, 'Receptor');
  assert.equal(spine.sent[0].payload.event_type, 'job_record_created');
});

test('intent_label emergency maps to priority critical', async () => {
  const { requestIntake, jobStore } = setup();
  const env = makeCanonicalReceptorEnvelope();
  env.payload.intent_label = 'emergency';
  const result = await requestIntake(env);
  assert.equal(result.handled, true);
  assert.equal(jobStore.get(result.job_urn).priority, 'critical');
});

test('intent_label feedback maps to priority low', async () => {
  const { requestIntake, jobStore } = setup();
  const env = makeCanonicalReceptorEnvelope();
  env.payload.intent_label = 'feedback';
  const result = await requestIntake(env);
  assert.equal(result.handled, true);
  assert.equal(jobStore.get(result.job_urn).priority, 'low');
});

test('unknown intent_label defaults to priority medium', async () => {
  const { requestIntake, jobStore } = setup();
  const env = makeCanonicalReceptorEnvelope();
  env.payload.intent_label = 'unknown_intent';
  const result = await requestIntake(env);
  assert.equal(result.handled, true);
  assert.equal(jobStore.get(result.job_urn).priority, 'medium');
});

test('missing intent_label rejects with missing_intent_label', async () => {
  const { requestIntake } = setup();
  const env = makeCanonicalReceptorEnvelope();
  delete env.payload.intent_label;
  const result = await requestIntake(env);
  assert.equal(result.handled, false);
  assert.equal(result.error, 'missing_intent_label');
});

test('missing payload_urn rejects with missing_payload_urn', async () => {
  const { requestIntake } = setup();
  const env = makeCanonicalReceptorEnvelope();
  delete env.payload.payload_urn;
  const result = await requestIntake(env);
  assert.equal(result.handled, false);
  assert.equal(result.error, 'missing_payload_urn');
});

test('wrong source_organ rejected', async () => {
  const { requestIntake } = setup();
  const env = makeCanonicalReceptorEnvelope();
  env.source_organ = 'Cortex';
  const result = await requestIntake(env);
  assert.equal(result.handled, false);
  assert.equal(result.error, 'wrong_source_organ');
});

test('wrong event_type rejected', async () => {
  const { requestIntake } = setup();
  const env = makeCanonicalReceptorEnvelope();
  env.payload.event_type = 'autonomous_goal';
  const result = await requestIntake(env);
  assert.equal(result.handled, false);
  assert.equal(result.error, 'wrong_event_type');
});

test('intake_context preserves intent_urn, channel, session_id, message verbatim', async () => {
  const { requestIntake, jobStore } = setup();
  const env = makeCanonicalReceptorEnvelope();
  const result = await requestIntake(env);
  const job = jobStore.get(result.job_urn);
  assert.equal(job.intake_context.intent_urn, 'urn:llm-ops:intent:question');
  assert.equal(job.intake_context.channel, 'axon');
  assert.equal(job.intake_context.session_id, 'urn:llm-ops:session:test-1');
  assert.deepEqual(job.intake_context.message, { text: 'how many backups ran today?' });
  assert.equal(job.intake_context.classification_confidence, 0.92);
  assert.equal(job.intake_context.user_identity, 'urn:llm-ops:user:leon');
});

test('description is intent_label + summarized message, capped at 240 chars', async () => {
  const { requestIntake, jobStore } = setup();
  const env = makeCanonicalReceptorEnvelope();
  const result = await requestIntake(env);
  const job = jobStore.get(result.job_urn);
  assert.ok(job.description.startsWith('question:'));
  assert.ok(job.description.length <= 240);
});

test('lifecycle ack is emitted with target_organ=Receptor', async () => {
  const { requestIntake, spine } = setup();
  const env = makeCanonicalReceptorEnvelope();
  await requestIntake(env);
  assert.equal(spine.sent.length, 1);
  assert.equal(spine.sent[0].target_organ, 'Receptor');
  assert.equal(spine.sent[0].payload.event_type, 'job_record_created');
});
