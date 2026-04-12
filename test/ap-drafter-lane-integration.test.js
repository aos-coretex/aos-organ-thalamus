import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAPDrafter } from '../lib/ap-drafter.js';
import { createLaneSelector } from '../lib/lane-selector.js';

const TABLE = {
  actions: {
    'Radiant:query': 'r0',
    'Engram:ingest': 'write',
  },
};

function fakeMissionLoader() {
  return {
    loadMission: async () => ({
      msp: { version: '1.0.0', hash: 'h', raw_text: '# msp', activated_at: '' },
      bor: { version: '1.0.0', hash: 'h', raw_text: '# bor' },
      loaded_at: '', cache_expires_at: '', degraded: [],
    }),
  };
}
function fakeCmEvidenceClient() {
  return { gather: async () => ({ evidence: [], degraded: [] }) };
}
function fakeJobLifecycle() {
  const calls = [];
  return {
    calls,
    markAwaitingAuth: async (urn, patch) => { calls.push({ urn, patch }); return { job_urn: urn, state: 'AWAITING_AUTH' }; },
  };
}
function fakeSpine() {
  const sent = [];
  return { sent, send: async (env) => { sent.push(env); return { message_id: 'urn:llm-ops:apm:assigned-1' }; } };
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
  intake_context: { kind: 'cortex_goal', target_state: 's', severity: 0.5, source_category: 'op' },
  evidence_refs: [],
  state: 'PLANNING',
};

function makeAPJson(targets, action_type = 'graph_concept_upsert') {
  return JSON.stringify({
    action: 'test action',
    reason: 'test reason',
    targets,
    risk_tier: 'medium',
    rollback_plan: 'noop',
    execution_plan: {
      targets: ['urn:resource:1'],
      action_type,
      credential_name: 'test',
      conditionState: {},
      payload: {},
    },
    evidence_refs: [],
  });
}

test('drafter accepts a write-only AP', async () => {
  const lifecycle = fakeJobLifecycle();
  const spine = fakeSpine();
  const drafter = createAPDrafter({
    llmConfig: {},
    injectedLlm: fakeLlm(makeAPJson(['Engram:ingest'])),
    missionLoader: fakeMissionLoader(),
    cmEvidenceClient: fakeCmEvidenceClient(),
    graphContext: null,
    spine,
    jobLifecycle: lifecycle,
    laneSelector: createLaneSelector({ table: TABLE }),
  }).draftAP;

  const result = await drafter(baseJob);
  assert.equal(result.submitted, true);
  assert.equal(spine.sent.length, 1);
  assert.equal(lifecycle.calls.length, 1);
});

test('drafter rejects an R0-only AP (write-only invariant)', async () => {
  const lifecycle = fakeJobLifecycle();
  const spine = fakeSpine();
  const drafter = createAPDrafter({
    llmConfig: {},
    injectedLlm: fakeLlm(makeAPJson(['Radiant:query'])),
    missionLoader: fakeMissionLoader(),
    cmEvidenceClient: fakeCmEvidenceClient(),
    graphContext: null,
    spine,
    jobLifecycle: lifecycle,
    laneSelector: createLaneSelector({ table: TABLE }),
  }).draftAP;

  const result = await drafter(baseJob);
  assert.equal(result.submitted, false);
  assert.ok(result.degraded.some(d => d.startsWith('ap-drafter-r0-targets')));
  assert.equal(spine.sent.length, 0, 'no APM may be sent for R0 jobs');
  assert.equal(lifecycle.calls.length, 0, 'no transition to AWAITING_AUTH');
});

test('drafter accepts mixed (R0 + write) AP and submits as write-lane', async () => {
  const lifecycle = fakeJobLifecycle();
  const spine = fakeSpine();
  const drafter = createAPDrafter({
    llmConfig: {},
    injectedLlm: fakeLlm(makeAPJson(['Radiant:query', 'Engram:ingest'])),
    missionLoader: fakeMissionLoader(),
    cmEvidenceClient: fakeCmEvidenceClient(),
    graphContext: null,
    spine,
    jobLifecycle: lifecycle,
    laneSelector: createLaneSelector({ table: TABLE }),
  }).draftAP;

  const result = await drafter(baseJob);
  assert.equal(result.submitted, true);
  assert.equal(spine.sent.length, 1);
});

test('drafter without laneSelector skips lane check (backwards compat with t3q-3 tests)', async () => {
  const lifecycle = fakeJobLifecycle();
  const spine = fakeSpine();
  const drafter = createAPDrafter({
    llmConfig: {},
    injectedLlm: fakeLlm(makeAPJson(['Radiant:query'])),
    missionLoader: fakeMissionLoader(),
    cmEvidenceClient: fakeCmEvidenceClient(),
    graphContext: null,
    spine,
    jobLifecycle: lifecycle,
    // no laneSelector
  }).draftAP;

  const result = await drafter(baseJob);
  assert.equal(result.submitted, true, 'absent laneSelector means no rejection');
});
