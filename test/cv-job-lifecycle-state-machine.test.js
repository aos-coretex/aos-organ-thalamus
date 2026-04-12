/**
 * CV: Job lifecycle state machine — 8-state machine through the lifecycle controller.
 *
 * Validates the full state graph:
 *   CREATED -> PLANNING -> AWAITING_AUTH -> DISPATCHED -> EXECUTING -> SUCCEEDED
 *   R0 fast-path: PLANNING -> DISPATCHED (skips AWAITING_AUTH)
 *   DENIED from AWAITING_AUTH
 *   FAILED from EXECUTING
 *   Illegal transitions throw JOB_STATE_CONFLICT
 *   Idempotent replays are no-ops
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createJobLifecycle } from '../lib/job-lifecycle.js';
import { createJobStore } from '../lib/job-store.js';

function fakeSpineStateClient() {
  return {
    createJobEntity: async (urn) => ({ entity_urn: urn }),
    transitionJob: async () => ({}),
    getJobEntity: async () => null,
    listNonTerminalJobs: async () => [],
  };
}

function setup() {
  const jobStore = createJobStore();
  const spineStateClient = fakeSpineStateClient();
  const lifecycle = createJobLifecycle({ spineStateClient, jobStore });
  return { lifecycle, jobStore, spineStateClient };
}

async function createTestJob(lifecycle) {
  return lifecycle.createJob({
    source: 'cortex',
    originator_ref: 'urn:llm-ops:otm:cv-lifecycle',
    reply_to: 'Cortex',
    priority: 'high',
    description: 'CV lifecycle test',
  });
}

test('CV: full write-lane lifecycle CREATED->PLANNING->AWAITING_AUTH->DISPATCHED->EXECUTING->SUCCEEDED', async () => {
  const { lifecycle } = setup();
  const job = await createTestJob(lifecycle);
  assert.equal(job.state, 'CREATED');

  const p = await lifecycle.markPlanning(job.job_urn);
  assert.equal(p.state, 'PLANNING');

  const aa = await lifecycle.markAwaitingAuth(job.job_urn, {
    ap_ref: 'urn:llm-ops:apm:cv-1',
    risk_tier: 'medium',
    rollback_plan: 'revert',
    targets: ['Engram:ingest'],
    evidence_refs: ['urn:llm-ops:radiant:block:1'],
    mission_frame_ref: '1.0.0-seed:1.0.0',
    execution_plan: { targets: ['urn:doc:1'], action_type: 'graph_concept_upsert', credential_name: 'test' },
  });
  assert.equal(aa.state, 'AWAITING_AUTH');

  const d = await lifecycle.markDispatched(job.job_urn, {
    token_urn: 'urn:graphheight:authorization_token:cv',
    target_organs: ['Cerberus'],
  });
  assert.equal(d.state, 'DISPATCHED');

  const ex = await lifecycle.markExecuting(job.job_urn, { execution_id: 'urn:llm-ops:execution:cv' });
  assert.equal(ex.state, 'EXECUTING');

  const s = await lifecycle.markSucceeded(job.job_urn, { result: { summary: 'done' } });
  assert.equal(s.state, 'SUCCEEDED');
  assert.deepEqual(s.result, { summary: 'done' });
});

test('CV: R0 fast-path PLANNING->DISPATCHED bypasses AWAITING_AUTH', async () => {
  const { lifecycle } = setup();
  const job = await createTestJob(lifecycle);

  await lifecycle.markPlanning(job.job_urn);
  const d = await lifecycle.markDispatched(job.job_urn, { target_organs: ['Radiant'] });
  assert.equal(d.state, 'DISPATCHED');

  await lifecycle.markExecuting(job.job_urn);
  const s = await lifecycle.markSucceeded(job.job_urn, { result: { rows: [] } });
  assert.equal(s.state, 'SUCCEEDED');
});

test('CV: DENIED reachable from AWAITING_AUTH', async () => {
  const { lifecycle } = setup();
  const job = await createTestJob(lifecycle);

  await lifecycle.markPlanning(job.job_urn);
  await lifecycle.markAwaitingAuth(job.job_urn, {
    ap_ref: 'urn:llm-ops:apm:cv-denied',
    risk_tier: 'high',
    rollback_plan: 'n/a',
    targets: ['Graph:upsert'],
    evidence_refs: [],
    mission_frame_ref: null,
    execution_plan: null,
  });
  const denied = await lifecycle.markDenied(job.job_urn, { reason: 'OUT_OF_SCOPE' });
  assert.equal(denied.state, 'DENIED');
  assert.equal(denied.denial_reason, 'OUT_OF_SCOPE');
});

test('CV: FAILED reachable from EXECUTING', async () => {
  const { lifecycle } = setup();
  const job = await createTestJob(lifecycle);

  await lifecycle.markPlanning(job.job_urn);
  await lifecycle.markDispatched(job.job_urn, { target_organs: ['Cerberus'] });
  await lifecycle.markExecuting(job.job_urn);
  const failed = await lifecycle.markFailed(job.job_urn, { error: 'cerberus_unreachable' });
  assert.equal(failed.state, 'FAILED');
  assert.equal(failed.error, 'cerberus_unreachable');
});

test('CV: illegal transition throws JOB_STATE_CONFLICT', async () => {
  const { lifecycle } = setup();
  const job = await createTestJob(lifecycle);

  // CREATED -> SUCCEEDED is illegal
  await assert.rejects(
    () => lifecycle.markSucceeded(job.job_urn, { result: {} }),
    (err) => {
      assert.equal(err.code, 'JOB_STATE_CONFLICT');
      assert.match(err.message, /CREATED.*SUCCEEDED/);
      return true;
    },
  );

  // CREATED -> DISPATCHED is also illegal
  await assert.rejects(
    () => lifecycle.markDispatched(job.job_urn),
    (err) => err.code === 'JOB_STATE_CONFLICT',
  );
});

test('CV: idempotent replay of same transition is a no-op', async () => {
  const { lifecycle } = setup();
  const job = await createTestJob(lifecycle);

  const first = await lifecycle.markPlanning(job.job_urn);
  const second = await lifecycle.markPlanning(job.job_urn);
  assert.equal(first.state, 'PLANNING');
  assert.equal(second.state, 'PLANNING');

  // Terminal state idempotency
  await lifecycle.markDispatched(job.job_urn, { target_organs: ['Radiant'] });
  await lifecycle.markExecuting(job.job_urn);
  await lifecycle.markSucceeded(job.job_urn, { result: { ok: true } });
  const replay = await lifecycle.markSucceeded(job.job_urn, { result: { ok: true } });
  assert.equal(replay.state, 'SUCCEEDED');
});
