/**
 * CV: Receptor request intake — consumes the canonical Receptor envelope
 * and validates source='receptor', priority from intent_label, and
 * intake_context field preservation.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeCanonicalReceptorEnvelope } from './fixtures/canonical-cortex-envelope.js';
import { createRequestIntake } from '../lib/request-intake.js';
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
  const requestIntake = createRequestIntake({ jobLifecycle: lifecycle, lifecycleAckEmitter: ackEmitter });
  return { requestIntake, jobStore, spine };
}

test('CV: canonical Receptor envelope produces source=receptor with correct priority', async () => {
  const { requestIntake, jobStore } = setup();
  const env = makeCanonicalReceptorEnvelope();
  const result = await requestIntake(env);

  assert.equal(result.handled, true);
  assert.match(result.job_urn, /^urn:llm-ops:job:/);

  const job = jobStore.get(result.job_urn);
  assert.equal(job.source, 'receptor');
  assert.equal(job.state, 'CREATED');
  // intent_label 'question' maps to 'medium' in RECEPTOR_INTENT_PRIORITY
  assert.equal(job.priority, 'medium');
  assert.equal(job.reply_to, 'Receptor');
});

test('CV: intake_context preserves intent_urn, payload_urn, channel, session_id', async () => {
  const { requestIntake, jobStore } = setup();
  const env = makeCanonicalReceptorEnvelope();
  const result = await requestIntake(env);

  const job = jobStore.get(result.job_urn);
  assert.equal(job.intake_context.kind, 'receptor_request');
  assert.equal(job.intake_context.intent_urn, env.payload.intent_urn);
  assert.equal(job.intake_context.payload_urn, env.payload.payload_urn);
  assert.equal(job.intake_context.channel, 'axon');
  assert.equal(job.intake_context.session_id, env.payload.session_id);
  assert.equal(job.intake_context.intent_label, 'question');
  assert.equal(job.intake_context.user_identity, env.payload.user_identity);
  assert.equal(job.intake_context.classification_confidence, 0.92);
  assert.deepEqual(job.intake_context.message, env.payload.message);
});

test('CV: lifecycle ack emitted to Receptor with job_record_created', async () => {
  const { requestIntake, spine } = setup();
  const env = makeCanonicalReceptorEnvelope();
  const result = await requestIntake(env);

  assert.equal(spine.sent.length, 1);
  const ack = spine.sent[0];
  assert.equal(ack.type, 'OTM');
  assert.equal(ack.source_organ, 'Thalamus');
  assert.equal(ack.target_organ, 'Receptor');
  assert.equal(ack.payload.event_type, 'job_record_created');
  assert.equal(ack.payload.job_id, result.job_urn);
});
