/**
 * CV: AP drafting with mission frame — end-to-end drafter test.
 *
 * Mocks: missionLoader (returns MSP+BoR), cmEvidenceClient, injectedLlm
 * returning VALID_AP_JSON from fixtures, spine.send returning a canned
 * message_id. Asserts submitted=true, ap_ref matches, APM envelope shape,
 * execution_plan persisted.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VALID_AP_JSON } from './fixtures/canonical-cortex-envelope.js';
import { createAPDrafter } from '../lib/ap-drafter.js';

const sampleMission = {
  msp: { version: '1.0.0-seed', hash: 'h1', raw_text: '# MSP\nMission: build the organism' },
  bor: { version: '1.0.0', hash: 'h2', raw_text: '# BoR\nRights: do no harm' },
  degraded: [],
};

const sampleJob = {
  job_urn: 'urn:llm-ops:job:cv-drafter-1',
  source: 'cortex',
  description: 'backups stale for 8 days',
  priority: 'high',
  state: 'PLANNING',
  lane: 'pending',
  evidence_refs: ['urn:llm-ops:radiant:block:42'],
  intake_context: {
    kind: 'cortex_goal',
    target_state: 'daily backup resumed',
    severity: 0.85,
    source_category: 'operational',
  },
};

function makeMockMissionLoader(frame = sampleMission) {
  return { loadMission: async () => frame, invalidate: () => {}, peekCache: () => frame };
}

function makeMockCmEvidence() {
  return { gather: async () => ({ evidence: [], degraded: [] }) };
}

function makeMockLlm(content = VALID_AP_JSON) {
  return {
    isAvailable: () => true,
    chat: async () => ({ content, model: 'test', input_tokens: 100, output_tokens: 200 }),
    getUsage: () => ({}),
  };
}

function makeMockLifecycle() {
  const calls = [];
  return {
    calls,
    markAwaitingAuth: async (urn, data) => {
      calls.push({ op: 'markAwaitingAuth', urn, data });
      return { job_urn: urn, state: 'AWAITING_AUTH', ...data };
    },
  };
}

function setup() {
  const sent = [];
  const spine = {
    sent,
    send: async (env) => { sent.push(env); return { message_id: 'urn:apm:cv' }; },
  };
  const jobLifecycle = makeMockLifecycle();
  const drafter = createAPDrafter({
    llmConfig: { agentName: 'cv-test', defaultModel: 'test', defaultProvider: 'anthropic', apiKeyEnvVar: 'TEST_KEY', maxTokens: 4096 },
    injectedLlm: makeMockLlm(),
    missionLoader: makeMockMissionLoader(),
    cmEvidenceClient: makeMockCmEvidence(),
    graphContext: null,
    spine,
    jobLifecycle,
  });
  return { drafter, spine, jobLifecycle };
}

test('CV: draftAP returns submitted=true with matching ap_ref', async () => {
  const { drafter } = setup();
  const result = await drafter.draftAP(sampleJob);

  assert.equal(result.submitted, true);
  assert.equal(result.ap_ref, 'urn:apm:cv');
  assert.equal(result.risk_tier, 'medium');
  assert.deepEqual(result.degraded, []);
});

test('CV: APM envelope has source_organ=Thalamus, target_organ=Nomos, execution_plan persisted', async () => {
  const { drafter, spine, jobLifecycle } = setup();
  await drafter.draftAP(sampleJob);

  assert.equal(spine.sent.length, 1);
  const env = spine.sent[0];
  assert.equal(env.type, 'APM');
  assert.equal(env.source_organ, 'Thalamus');
  assert.equal(env.target_organ, 'Nomos');
  assert.equal(env.reply_to, 'Thalamus');
  assert.equal(env.payload.job_reference, sampleJob.job_urn);
  assert.equal(env.payload.action, 'Re-run nightly backup');
  assert.deepEqual(env.payload.targets, ['SafeVault:backup']);
  assert.equal(env.payload.risk_tier, 'medium');

  // Verify lifecycle transition carries execution_plan
  assert.equal(jobLifecycle.calls.length, 1);
  const lc = jobLifecycle.calls[0];
  assert.equal(lc.op, 'markAwaitingAuth');
  assert.equal(lc.data.ap_ref, 'urn:apm:cv');
  assert.ok(lc.data.execution_plan, 'execution_plan must be persisted in lifecycle transition');
  assert.equal(lc.data.execution_plan.action_type, 'safevault_backup_run');
  assert.equal(lc.data.execution_plan.credential_name, 'coretex.cerberus.safevault_writer');
});

test('CV: draftAP fail-closed when mission absent', async () => {
  const sent = [];
  const spine = { sent, send: async (env) => { sent.push(env); return { message_id: 'urn:apm:cv' }; } };
  const drafter = createAPDrafter({
    llmConfig: { agentName: 'cv-test', defaultModel: 'test', defaultProvider: 'anthropic', apiKeyEnvVar: 'TEST_KEY', maxTokens: 4096 },
    injectedLlm: makeMockLlm(),
    missionLoader: makeMockMissionLoader({ msp: null, bor: null, degraded: [] }),
    cmEvidenceClient: makeMockCmEvidence(),
    graphContext: null,
    spine,
    jobLifecycle: makeMockLifecycle(),
  });
  const result = await drafter.draftAP(sampleJob);

  assert.equal(result.submitted, false);
  assert.ok(result.degraded.some(d => d.includes('mission-fully-absent')));
  assert.equal(spine.sent.length, 0, 'no APM sent when mission absent');
});
