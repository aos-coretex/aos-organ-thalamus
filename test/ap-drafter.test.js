import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAPDrafter } from '../lib/ap-drafter.js';

const VALID_AP_JSON = JSON.stringify({
  action: 'Re-run nightly backup',
  reason: 'Backups stale for 8 days',
  targets: ['SafeVault:backup'],
  risk_tier: 'medium',
  rollback_plan: 'Backup is read-only; nothing to roll back',
  execution_plan: {
    targets: ['urn:llm-ops:safevault:nas-01'],
    action_type: 'safevault_backup_run',
    credential_name: 'coretex.cerberus.safevault_writer',
    conditionState: {},
    payload: { dry_run: false },
  },
  evidence_refs: ['urn:llm-ops:radiant:block:42'],
});

const sampleMission = {
  msp: { version: '1.0.0-seed', hash: 'h1', raw_text: '# MSP' },
  bor: { version: '1.0.0', hash: 'h2', raw_text: '# BoR' },
  degraded: [],
};

const sampleJob = {
  job_urn: 'urn:llm-ops:job:test-1',
  source: 'cortex',
  description: 'backups stale',
  priority: 'high',
  state: 'PLANNING',
  lane: 'pending',
  evidence_refs: ['urn:llm-ops:radiant:block:42'],
  intake_context: { kind: 'cortex_goal', target_state: 'daily backup resumed', severity: 0.85, source_category: 'operational' },
};

function makeMockMissionLoader(frame = sampleMission) {
  return { loadMission: async () => frame, invalidate: () => {}, peekCache: () => frame };
}

function makeMockCmEvidence(evidence = []) {
  return { gather: async () => ({ evidence, degraded: [] }) };
}

function makeMockLlm({ content = VALID_AP_JSON, throws = false, available = true } = {}) {
  return {
    isAvailable: () => available,
    chat: async () => {
      if (throws) throw new Error('llm_error');
      return { content, model: 'test', input_tokens: 100, output_tokens: 200 };
    },
    getUsage: () => ({}),
  };
}

function makeMockSpine({ messageId = 'urn:llm-ops:apm:test-1', throws = false, noId = false } = {}) {
  const sent = [];
  return {
    sent,
    send: async (env) => {
      if (throws) throw new Error('spine_offline');
      sent.push(env);
      return noId ? {} : { message_id: messageId };
    },
  };
}

function makeMockLifecycle({ throws = false } = {}) {
  const calls = [];
  return {
    calls,
    markAwaitingAuth: async (urn, data) => {
      if (throws) throw new Error('lifecycle_error');
      calls.push({ op: 'markAwaitingAuth', urn, data });
      return { job_urn: urn, state: 'AWAITING_AUTH', ...data };
    },
  };
}

function setup(overrides = {}) {
  const spine = overrides.spine || makeMockSpine();
  const jobLifecycle = overrides.jobLifecycle || makeMockLifecycle();
  const drafter = createAPDrafter({
    llmConfig: { agentName: 'test', defaultModel: 'test', defaultProvider: 'anthropic', apiKeyEnvVar: 'TEST_KEY', maxTokens: 4096 },
    injectedLlm: overrides.llm || makeMockLlm(),
    missionLoader: overrides.missionLoader || makeMockMissionLoader(),
    cmEvidenceClient: overrides.cmEvidenceClient || makeMockCmEvidence(),
    graphContext: null,
    spine,
    jobLifecycle,
  });
  return { drafter, spine, jobLifecycle };
}

test('happy path: drafts AP, submits APM, transitions to AWAITING_AUTH', async () => {
  const { drafter, spine, jobLifecycle } = setup();
  const result = await drafter.draftAP(sampleJob);

  assert.equal(result.submitted, true);
  assert.equal(result.ap_ref, 'urn:llm-ops:apm:test-1');
  assert.equal(result.risk_tier, 'medium');
  assert.ok(result.execution_plan);
  assert.deepEqual(result.degraded, []);

  // Verify APM envelope shape
  assert.equal(spine.sent.length, 1);
  const env = spine.sent[0];
  assert.equal(env.type, 'APM');
  assert.equal(env.source_organ, 'Thalamus');
  assert.equal(env.target_organ, 'Nomos');
  assert.equal(env.reply_to, 'Thalamus');
  assert.equal(env.message_id, undefined, 'Spine assigns message_id');
  assert.equal(env.payload.action, 'Re-run nightly backup');
  assert.deepEqual(env.payload.targets, ['SafeVault:backup']);
  assert.equal(env.payload.risk_tier, 'medium');
  assert.ok(env.payload.rollback_plan);
  assert.ok(env.payload.reason);
  assert.ok(env.payload.evidence_refs);
  assert.equal(env.payload.job_reference, sampleJob.job_urn);

  // Verify lifecycle transition
  assert.equal(jobLifecycle.calls.length, 1);
  assert.equal(jobLifecycle.calls[0].op, 'markAwaitingAuth');
  assert.equal(jobLifecycle.calls[0].data.ap_ref, 'urn:llm-ops:apm:test-1');
  assert.equal(jobLifecycle.calls[0].data.risk_tier, 'medium');
  assert.ok(jobLifecycle.calls[0].data.execution_plan);
});

test('mission absent: fail-closed — both MSP and BoR null', async () => {
  const { drafter, spine } = setup({
    missionLoader: makeMockMissionLoader({ msp: null, bor: null, degraded: ['msp-missing-from-graph', 'bor-unavailable'] }),
  });
  const result = await drafter.draftAP(sampleJob);
  assert.equal(result.submitted, false);
  assert.ok(result.degraded.some(d => d.includes('mission-fully-absent')));
  assert.equal(spine.sent.length, 0, 'no APM should be sent');
});

test('degraded mission still submits when at least one is present', async () => {
  const { drafter } = setup({
    missionLoader: makeMockMissionLoader({ msp: sampleMission.msp, bor: null, degraded: ['bor-unavailable'] }),
  });
  const result = await drafter.draftAP(sampleJob);
  assert.equal(result.submitted, true);
  assert.ok(result.degraded.some(d => d.includes('mission:bor-unavailable')));
});

test('LLM unavailable: fail-closed', async () => {
  const { drafter, spine } = setup({ llm: makeMockLlm({ available: false }) });
  const result = await drafter.draftAP(sampleJob);
  assert.equal(result.submitted, false);
  assert.ok(result.degraded.includes('llm-unavailable'));
  assert.equal(spine.sent.length, 0);
});

test('LLM throws: fail-closed', async () => {
  const { drafter, spine } = setup({ llm: makeMockLlm({ throws: true }) });
  const result = await drafter.draftAP(sampleJob);
  assert.equal(result.submitted, false);
  assert.ok(result.degraded.some(d => d.includes('llm-error')));
  assert.equal(spine.sent.length, 0);
});

test('LLM returns invalid JSON: fail-closed with parse-error', async () => {
  const { drafter, spine } = setup({ llm: makeMockLlm({ content: '{not json' }) });
  const result = await drafter.draftAP(sampleJob);
  assert.equal(result.submitted, false);
  assert.ok(result.degraded.some(d => d.includes('parse-error')));
  assert.equal(spine.sent.length, 0);
});

test('spine.send fails: fail-closed', async () => {
  const { drafter, jobLifecycle } = setup({ spine: makeMockSpine({ throws: true }) });
  const result = await drafter.draftAP(sampleJob);
  assert.equal(result.submitted, false);
  assert.ok(result.degraded.some(d => d.includes('apm-send-failed')));
  assert.equal(jobLifecycle.calls.length, 0, 'markAwaitingAuth should NOT be called');
});

test('spine.send returns no message_id: fail-closed', async () => {
  const { drafter } = setup({ spine: makeMockSpine({ noId: true }) });
  const result = await drafter.draftAP(sampleJob);
  assert.equal(result.submitted, false);
  assert.ok(result.degraded.includes('apm-no-message-id'));
});

test('post-send transition fails: submitted=true with degraded flag', async () => {
  const { drafter } = setup({ jobLifecycle: makeMockLifecycle({ throws: true }) });
  const result = await drafter.draftAP(sampleJob);
  assert.equal(result.submitted, true, 'APM is on the wire');
  assert.equal(result.ap_ref, 'urn:llm-ops:apm:test-1');
  assert.ok(result.degraded.some(d => d.includes('post-send-transition-failed')));
});

test('evidence gather failure is non-fatal', async () => {
  const { drafter } = setup({
    cmEvidenceClient: { gather: async () => { throw new Error('evidence boom'); } },
  });
  const result = await drafter.draftAP(sampleJob);
  assert.equal(result.submitted, true, 'draft should still proceed');
  assert.ok(result.degraded.some(d => d.includes('evidence-gather-error')));
});
