import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAtmForwarder } from '../lib/atm-forwarder.js';

function fakeSpine({ messageId = 'urn:llm-ops:atm:fwd-1', throws = false } = {}) {
  const sent = [];
  return { sent, send: async (env) => { if (throws) throw new Error('spine_offline'); sent.push(env); return { message_id: messageId }; } };
}
function fakeLifecycle({ throws = false } = {}) {
  const calls = [];
  return { calls, markDispatched: async (urn, d) => { if (throws) throw new Error('lifecycle_err'); calls.push({ urn, d }); } };
}

const sampleJob = {
  job_urn: 'urn:llm-ops:job:test-1',
  execution_plan: { targets: ['urn:res:1'], action_type: 'graph_concept_upsert', credential_name: 'test_cred', conditionState: { ok: true }, payload: { data: 1 } },
};
const sampleAtm = {
  type: 'ATM', source_organ: 'Nomos', target_organ: 'Thalamus',
  payload: { token_urn: 'urn:graphheight:token:1', scope: { action_types: ['graph_concept_upsert'] }, ap_ref: 'urn:llm-ops:apm:1', ruling_ref: 'urn:llm-ops:ruling:1' },
};

test('happy path: forwards enriched ATM to Cerberus', async () => {
  const spine = fakeSpine();
  const lifecycle = fakeLifecycle();
  const fwd = createAtmForwarder({ spine, jobLifecycle: lifecycle });
  const result = await fwd.forwardAtm({ jobRecord: sampleJob, atmEnvelope: sampleAtm });
  assert.equal(result.forwarded, true);
  assert.equal(result.target, 'Cerberus');
  assert.equal(result.execution_request_attached, true);
  const env = spine.sent[0];
  assert.equal(env.type, 'ATM');
  assert.equal(env.source_organ, 'Thalamus');
  assert.equal(env.target_organ, 'Cerberus');
  assert.equal(env.payload.token_urn, sampleAtm.payload.token_urn);
  assert.equal(env.payload.scope, sampleAtm.payload.scope);
  assert.equal(env.payload.ap_ref, sampleAtm.payload.ap_ref);
  assert.equal(env.payload.ruling_ref, sampleAtm.payload.ruling_ref);
  assert.equal(env.payload.execution_request.action_type, 'graph_concept_upsert');
  assert.equal(env.payload.execution_request.credential_name, 'test_cred');
  assert.deepEqual(env.payload.execution_request.targets, ['urn:res:1']);
  assert.equal(env.message_id, undefined, 'Spine assigns message_id');
});

test('jobRecord null -> error', async () => {
  const fwd = createAtmForwarder({ spine: fakeSpine(), jobLifecycle: fakeLifecycle() });
  const result = await fwd.forwardAtm({ jobRecord: null, atmEnvelope: sampleAtm });
  assert.equal(result.forwarded, false);
  assert.equal(result.error, 'job_not_found_for_ap_ref');
});

test('missing execution_plan -> error', async () => {
  const fwd = createAtmForwarder({ spine: fakeSpine(), jobLifecycle: fakeLifecycle() });
  const result = await fwd.forwardAtm({ jobRecord: { job_urn: 'x', execution_plan: null }, atmEnvelope: sampleAtm });
  assert.equal(result.forwarded, false);
  assert.equal(result.error, 'execution_plan_missing');
});

test('spine.send throws -> error', async () => {
  const fwd = createAtmForwarder({ spine: fakeSpine({ throws: true }), jobLifecycle: fakeLifecycle() });
  const result = await fwd.forwardAtm({ jobRecord: sampleJob, atmEnvelope: sampleAtm });
  assert.equal(result.forwarded, false);
  assert.ok(result.error.includes('spine_send_failed'));
});

test('post-send transition fails -> forwarded:true with error flag', async () => {
  const fwd = createAtmForwarder({ spine: fakeSpine(), jobLifecycle: fakeLifecycle({ throws: true }) });
  const result = await fwd.forwardAtm({ jobRecord: sampleJob, atmEnvelope: sampleAtm });
  assert.equal(result.forwarded, true);
  assert.ok(result.post_send_transition_error);
});

test('conditionState defaults to {} when undefined', async () => {
  const spine = fakeSpine();
  const fwd = createAtmForwarder({ spine, jobLifecycle: fakeLifecycle() });
  const job = { ...sampleJob, execution_plan: { ...sampleJob.execution_plan, conditionState: undefined } };
  await fwd.forwardAtm({ jobRecord: job, atmEnvelope: sampleAtm });
  assert.deepEqual(spine.sent[0].payload.execution_request.conditionState, {});
});

test('payload defaults to {} when undefined', async () => {
  const spine = fakeSpine();
  const fwd = createAtmForwarder({ spine, jobLifecycle: fakeLifecycle() });
  const job = { ...sampleJob, execution_plan: { ...sampleJob.execution_plan, payload: undefined } };
  await fwd.forwardAtm({ jobRecord: job, atmEnvelope: sampleAtm });
  assert.deepEqual(spine.sent[0].payload.execution_request.payload, {});
});
