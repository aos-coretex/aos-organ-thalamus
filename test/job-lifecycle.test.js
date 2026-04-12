import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createJobLifecycle } from '../lib/job-lifecycle.js';
import { createJobStore } from '../lib/job-store.js';

// Fake spine-state client — records calls, returns canned responses
function makeFakeSpineStateClient({ failOn = null } = {}) {
  const calls = [];
  return {
    calls,
    async createJobEntity(urn, metadata) {
      calls.push({ op: 'create', urn, metadata });
      if (failOn === 'create') throw new Error('spine-state-fake-fail');
      return { entity_urn: urn, state: 'CREATED' };
    },
    async transitionJob(urn, from, to, reason) {
      calls.push({ op: 'transition', urn, from, to, reason });
      if (failOn === 'transition') throw new Error('spine-state-fake-fail');
      return { entity_urn: urn, from_state: from, to_state: to };
    },
    async getJobEntity(urn) {
      calls.push({ op: 'get', urn });
      return null;
    },
    async listNonTerminalJobs() {
      return [];
    },
  };
}

function setup({ failOn = null } = {}) {
  const spineStateClient = makeFakeSpineStateClient({ failOn });
  const jobStore = createJobStore();
  const lifecycle = createJobLifecycle({ spineStateClient, jobStore });
  return { lifecycle, jobStore, spineStateClient };
}

test('createJob mints a job URN, persists to spine-state, and caches the record', async () => {
  const { lifecycle, jobStore, spineStateClient } = setup();
  const job = await lifecycle.createJob({
    source: 'cortex',
    originator_ref: 'urn:llm-ops:otm:test-1',
    reply_to: 'Cortex',
    priority: 'high',
    description: 'test',
  });

  assert.match(job.job_urn, /^urn:llm-ops:job:/);
  assert.equal(job.state, 'CREATED');
  assert.equal(job.source, 'cortex');
  assert.equal(job.priority, 'high');
  assert.equal(jobStore.size(), 1);
  assert.equal(spineStateClient.calls[0].op, 'create');
  assert.equal(spineStateClient.calls[0].metadata.source, 'cortex');
});

test('createJob throws if spine-state fails (no orphan cache entry)', async () => {
  const { lifecycle, jobStore } = setup({ failOn: 'create' });
  await assert.rejects(
    () => lifecycle.createJob({ source: 'cortex', originator_ref: 'x', reply_to: 'Cortex' }),
    /spine-state-fake-fail/,
  );
  assert.equal(jobStore.size(), 0, 'cache must not contain a job whose spine-state creation failed');
});

test('full happy-path lifecycle CREATED -> PLANNING -> AWAITING_AUTH -> DISPATCHED -> EXECUTING -> SUCCEEDED', async () => {
  const { lifecycle, spineStateClient } = setup();
  const job = await lifecycle.createJob({ source: 'cortex', originator_ref: 'x', reply_to: 'Cortex' });

  await lifecycle.markPlanning(job.job_urn);
  await lifecycle.markAwaitingAuth(job.job_urn, {
    ap_ref: 'urn:llm-ops:apm:test-1',
    risk_tier: 'medium',
    rollback_plan: 'noop',
    targets: ['Engram:ingest'],
    evidence_refs: [],
    mission_frame_ref: null,
    execution_plan: { targets: ['urn:doc:1'], action_type: 'graph_concept_upsert', credential_name: 'test' },
  });
  await lifecycle.markDispatched(job.job_urn, { token_urn: 'urn:graphheight:authorization_token:test', target_organs: ['Cerberus'] });
  await lifecycle.markExecuting(job.job_urn, { execution_id: 'urn:llm-ops:execution:test' });
  await lifecycle.markSucceeded(job.job_urn, { result: { summary: 'ok' } });

  const final = lifecycle.getJob(job.job_urn);
  assert.equal(final.state, 'SUCCEEDED');
  assert.equal(final.lane, 'write');
  assert.equal(final.ap_ref, 'urn:llm-ops:apm:test-1');
  assert.equal(final.token_urn, 'urn:graphheight:authorization_token:test');
  // 1 create + 5 transitions = 6 spine-state calls
  assert.equal(spineStateClient.calls.length, 6);
});

test('R0 happy path PLANNING -> DISPATCHED (skips AWAITING_AUTH)', async () => {
  const { lifecycle } = setup();
  const job = await lifecycle.createJob({ source: 'cortex', originator_ref: 'x', reply_to: 'Cortex' });
  await lifecycle.markPlanning(job.job_urn);
  await lifecycle.markDispatched(job.job_urn, { target_organs: ['Radiant'] });
  await lifecycle.markExecuting(job.job_urn);
  await lifecycle.markSucceeded(job.job_urn, { result: { rows: [] } });
  assert.equal(lifecycle.getJob(job.job_urn).state, 'SUCCEEDED');
});

test('write-lane DENIED reachable from AWAITING_AUTH', async () => {
  const { lifecycle } = setup();
  const job = await lifecycle.createJob({ source: 'cortex', originator_ref: 'x', reply_to: 'Cortex' });
  await lifecycle.markPlanning(job.job_urn);
  await lifecycle.markAwaitingAuth(job.job_urn, { ap_ref: 'urn:llm-ops:apm:test', risk_tier: 'high', rollback_plan: '', targets: [], evidence_refs: [], mission_frame_ref: null, execution_plan: null });
  await lifecycle.markDenied(job.job_urn, { reason: 'OUT_OF_SCOPE' });
  assert.equal(lifecycle.getJob(job.job_urn).state, 'DENIED');
  assert.equal(lifecycle.getJob(job.job_urn).denial_reason, 'OUT_OF_SCOPE');
});

test('FAILED reachable from EXECUTING', async () => {
  const { lifecycle } = setup();
  const job = await lifecycle.createJob({ source: 'receptor', originator_ref: 'x', reply_to: 'Receptor' });
  await lifecycle.markPlanning(job.job_urn);
  await lifecycle.markDispatched(job.job_urn, { target_organs: ['Cerberus'] });
  await lifecycle.markExecuting(job.job_urn);
  await lifecycle.markFailed(job.job_urn, { error: 'cerberus_unreachable' });
  assert.equal(lifecycle.getJob(job.job_urn).state, 'FAILED');
});

test('illegal transitions throw JOB_STATE_CONFLICT before reaching spine-state', async () => {
  const { lifecycle, spineStateClient } = setup();
  const job = await lifecycle.createJob({ source: 'cortex', originator_ref: 'x', reply_to: 'Cortex' });
  // CREATED -> SUCCEEDED is not a legal transition
  await assert.rejects(
    () => lifecycle.markSucceeded(job.job_urn, { result: {} }),
    (err) => err.code === 'JOB_STATE_CONFLICT',
  );
  // The illegal transition should NOT have hit spine-state
  const transitionCalls = spineStateClient.calls.filter(c => c.op === 'transition');
  assert.equal(transitionCalls.length, 0);
});

test('idempotent re-transition is a no-op', async () => {
  const { lifecycle, spineStateClient } = setup();
  const job = await lifecycle.createJob({ source: 'cortex', originator_ref: 'x', reply_to: 'Cortex' });
  await lifecycle.markPlanning(job.job_urn);
  // Replay PLANNING — should be a no-op
  await lifecycle.markPlanning(job.job_urn);
  const transitionCalls = spineStateClient.calls.filter(c => c.op === 'transition');
  assert.equal(transitionCalls.length, 1, 'second markPlanning must NOT issue a second transition');
});

test('terminal-state idempotent re-transition is a no-op', async () => {
  const { lifecycle } = setup();
  const job = await lifecycle.createJob({ source: 'cortex', originator_ref: 'x', reply_to: 'Cortex' });
  await lifecycle.markPlanning(job.job_urn);
  await lifecycle.markDispatched(job.job_urn, { target_organs: ['Radiant'] });
  await lifecycle.markExecuting(job.job_urn);
  await lifecycle.markSucceeded(job.job_urn, { result: {} });
  // Replay SUCCEEDED — must remain SUCCEEDED, no error
  await lifecycle.markSucceeded(job.job_urn, { result: {} });
  assert.equal(lifecycle.getJob(job.job_urn).state, 'SUCCEEDED');
});

test('reason field includes JSON-encoded enrichment delta', async () => {
  const { lifecycle, spineStateClient } = setup();
  const job = await lifecycle.createJob({ source: 'cortex', originator_ref: 'x', reply_to: 'Cortex' });
  await lifecycle.markPlanning(job.job_urn);
  await lifecycle.markAwaitingAuth(job.job_urn, {
    ap_ref: 'urn:apm:1',
    risk_tier: 'high',
    rollback_plan: 'r',
    targets: ['Engram:ingest'],
    evidence_refs: [],
    mission_frame_ref: null,
    execution_plan: null,
  });
  const lastTransition = spineStateClient.calls.filter(c => c.op === 'transition').pop();
  const reasonObj = JSON.parse(lastTransition.reason);
  assert.equal(reasonObj.to_state, 'AWAITING_AUTH');
  assert.equal(reasonObj.ap_ref, 'urn:apm:1');
  assert.equal(reasonObj.risk_tier, 'high');
});

test('isLegalTransition matches the spine-state pre-baked machine', () => {
  const { lifecycle } = setup();
  // Sample a cross-section of legal/illegal pairs
  assert.equal(lifecycle.isLegalTransition('CREATED', 'PLANNING'), true);
  assert.equal(lifecycle.isLegalTransition('PLANNING', 'AWAITING_AUTH'), true);
  assert.equal(lifecycle.isLegalTransition('PLANNING', 'DISPATCHED'), true); // R0 fast-path
  assert.equal(lifecycle.isLegalTransition('AWAITING_AUTH', 'DENIED'), true);
  assert.equal(lifecycle.isLegalTransition('EXECUTING', 'SUCCEEDED'), true);
  assert.equal(lifecycle.isLegalTransition('CREATED', 'SUCCEEDED'), false);
  assert.equal(lifecycle.isLegalTransition('SUCCEEDED', 'EXECUTING'), false);
  assert.equal(lifecycle.isLegalTransition('DENIED', 'PLANNING'), false);
});

test('TERMINAL_STATES includes SUCCEEDED, DENIED, FAILED', () => {
  const { lifecycle } = setup();
  assert.deepEqual(lifecycle.TERMINAL_STATES.sort(), ['DENIED', 'FAILED', 'SUCCEEDED']);
});
