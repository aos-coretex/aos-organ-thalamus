import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAPDrafter } from '../lib/ap-drafter.js';
import { createGraphContext } from '../lib/graph-context.js';

const VALID_AP_JSON = JSON.stringify({
  action: 'Test action',
  reason: 'Test reason',
  targets: ['Engram:ingest'],
  risk_tier: 'medium',
  rollback_plan: 'noop',
  execution_plan: {
    targets: ['urn:resource:1'],
    action_type: 'graph_concept_upsert',
    credential_name: 'test',
    conditionState: {},
    payload: {},
  },
  evidence_refs: [],
});

function fakeMissionLoader() {
  return {
    loadMission: async () => ({
      msp: { version: '1.0.0', hash: 'h', raw_text: '# msp' },
      bor: { version: '1.0.0', hash: 'h', raw_text: '# bor' },
      loaded_at: '', cache_expires_at: '', degraded: [],
    }),
  };
}
function fakeCmEvidenceClient() {
  return { gather: async () => ({ evidence: [], degraded: [] }) };
}
function fakeJobLifecycle() {
  return { markAwaitingAuth: async (urn, patch) => ({ job_urn: urn, state: 'AWAITING_AUTH' }) };
}
function fakeSpine() {
  return { send: async () => ({ message_id: 'urn:llm-ops:apm:test' }) };
}
function fakeLlm(content) {
  return {
    isAvailable: () => true,
    chat: async () => ({ content }),
  };
}

const baseJob = {
  job_urn: 'urn:llm-ops:job:test',
  source: 'cortex',
  description: 'test',
  priority: 'medium',
  intake_context: { kind: 'cortex_goal', target_state: 's', severity: 0.5, source_category: 'op', gap_ref: 'urn:llm-ops:gap:1' },
  evidence_refs: ['urn:llm-ops:r:1'],
  state: 'PLANNING',
};

test('drafter calls graphContext.enrich with jobRecord', async () => {
  let enrichCalled = false;
  let enrichArgs = null;
  const graphContext = {
    enrich: async (args) => {
      enrichCalled = true;
      enrichArgs = args;
      return { entities: [{ urn: 'urn:test', data: {} }], bindings: [], seeds_used: ['urn:llm-ops:r:1'], degraded: [] };
    },
  };

  const drafter = createAPDrafter({
    llmConfig: {},
    injectedLlm: fakeLlm(VALID_AP_JSON),
    missionLoader: fakeMissionLoader(),
    cmEvidenceClient: fakeCmEvidenceClient(),
    graphContext,
    spine: fakeSpine(),
    jobLifecycle: fakeJobLifecycle(),
  }).draftAP;

  await drafter(baseJob);
  assert.equal(enrichCalled, true);
  assert.ok(enrichArgs.jobRecord);
  assert.equal(enrichArgs.jobRecord.job_urn, baseJob.job_urn);
});

test('drafter proceeds when graphContext returns degraded (non-blocking)', async () => {
  const graphContext = {
    enrich: async () => ({ entities: [], bindings: [], seeds_used: [], degraded: ['graphheight-read-failed'] }),
  };

  const drafter = createAPDrafter({
    llmConfig: {},
    injectedLlm: fakeLlm(VALID_AP_JSON),
    missionLoader: fakeMissionLoader(),
    cmEvidenceClient: fakeCmEvidenceClient(),
    graphContext,
    spine: fakeSpine(),
    jobLifecycle: fakeJobLifecycle(),
  }).draftAP;

  const result = await drafter(baseJob);
  assert.equal(result.submitted, true);
  assert.ok(result.degraded.some(d => d.includes('graph:graphheight-read-failed')));
});

test('drafter proceeds when graphContext throws (caught + logged)', async () => {
  const graphContext = {
    enrich: async () => { throw new Error('graph-boom'); },
  };

  const drafter = createAPDrafter({
    llmConfig: {},
    injectedLlm: fakeLlm(VALID_AP_JSON),
    missionLoader: fakeMissionLoader(),
    cmEvidenceClient: fakeCmEvidenceClient(),
    graphContext,
    spine: fakeSpine(),
    jobLifecycle: fakeJobLifecycle(),
  }).draftAP;

  const result = await drafter(baseJob);
  assert.equal(result.submitted, true);
  assert.ok(result.degraded.includes('graph-context-error'));
});

test('drafter without graphContext (null) skips the call (backwards compat)', async () => {
  const drafter = createAPDrafter({
    llmConfig: {},
    injectedLlm: fakeLlm(VALID_AP_JSON),
    missionLoader: fakeMissionLoader(),
    cmEvidenceClient: fakeCmEvidenceClient(),
    graphContext: null,
    spine: fakeSpine(),
    jobLifecycle: fakeJobLifecycle(),
  }).draftAP;

  const result = await drafter(baseJob);
  assert.equal(result.submitted, true);
});
