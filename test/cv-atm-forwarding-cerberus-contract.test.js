/**
 * CV: ATM forwarding Cerberus contract (CONTRACT LOCK).
 *
 * Validates the enriched ATM envelope shape that Thalamus sends to Cerberus.
 * Cerberus's atm-handler.js requires:
 *   - type === 'ATM'
 *   - source_organ === 'Thalamus'
 *   - target_organ === 'Cerberus'
 *   - payload.execution_request present with targets, action_type, credential_name,
 *     conditionState, payload
 *   - payload.token_urn, scope, ap_ref, ruling_ref preserved from Nomos ATM
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAtmForwarder } from '../lib/atm-forwarder.js';

function fakeSpine() {
  const sent = [];
  return { sent, send: async (env) => { sent.push(env); return { message_id: 'urn:test:cv' }; } };
}

function fakeLifecycle() {
  return { markDispatched: async () => ({}) };
}

const sampleJobRecord = {
  job_urn: 'urn:llm-ops:job:cv-contract-1',
  execution_plan: {
    targets: ['urn:res:1'],
    action_type: 'graph_concept_upsert',
    credential_name: 'test_cred',
    conditionState: { ok: true },
    payload: { data: 1 },
  },
};

const sampleNomosAtm = {
  type: 'ATM',
  source_organ: 'Nomos',
  target_organ: 'Thalamus',
  payload: {
    token_urn: 'urn:graphheight:authorization_token:cv-1',
    scope: { action_types: ['graph_concept_upsert'], target_urns: ['urn:res:1'] },
    ap_ref: 'urn:llm-ops:apm:cv-contract-1',
    ruling_ref: 'urn:llm-ops:ruling:cv-contract-1',
  },
};

test('CV: forwarded envelope type is ATM with source_organ=Thalamus, target_organ=Cerberus', async () => {
  const spine = fakeSpine();
  const fwd = createAtmForwarder({ spine, jobLifecycle: fakeLifecycle() });
  await fwd.forwardAtm({ jobRecord: sampleJobRecord, atmEnvelope: sampleNomosAtm });

  assert.equal(spine.sent.length, 1);
  const env = spine.sent[0];
  assert.equal(env.type, 'ATM');
  assert.equal(env.source_organ, 'Thalamus');
  assert.equal(env.target_organ, 'Cerberus');
});

test('CV: execution_request present with all 5 required fields', async () => {
  const spine = fakeSpine();
  const fwd = createAtmForwarder({ spine, jobLifecycle: fakeLifecycle() });
  await fwd.forwardAtm({ jobRecord: sampleJobRecord, atmEnvelope: sampleNomosAtm });

  const er = spine.sent[0].payload.execution_request;
  assert.ok(er, 'execution_request must be present');
  assert.deepEqual(er.targets, ['urn:res:1']);
  assert.equal(er.action_type, 'graph_concept_upsert');
  assert.equal(er.credential_name, 'test_cred');
  assert.deepEqual(er.conditionState, { ok: true });
  assert.deepEqual(er.payload, { data: 1 });
});

test('CV: token_urn, scope, ap_ref, ruling_ref preserved from Nomos ATM', async () => {
  const spine = fakeSpine();
  const fwd = createAtmForwarder({ spine, jobLifecycle: fakeLifecycle() });
  await fwd.forwardAtm({ jobRecord: sampleJobRecord, atmEnvelope: sampleNomosAtm });

  const p = spine.sent[0].payload;
  assert.equal(p.token_urn, sampleNomosAtm.payload.token_urn);
  assert.deepEqual(p.scope, sampleNomosAtm.payload.scope);
  assert.equal(p.ap_ref, sampleNomosAtm.payload.ap_ref);
  assert.equal(p.ruling_ref, sampleNomosAtm.payload.ruling_ref);
});

test('CV: job_reference set to jobRecord.job_urn in forwarded envelope', async () => {
  const spine = fakeSpine();
  const fwd = createAtmForwarder({ spine, jobLifecycle: fakeLifecycle() });
  await fwd.forwardAtm({ jobRecord: sampleJobRecord, atmEnvelope: sampleNomosAtm });

  assert.equal(spine.sent[0].payload.job_reference, sampleJobRecord.job_urn);
});
