import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPlanner } from '../lib/planner.js';
import { createJobLifecycle } from '../lib/job-lifecycle.js';
import { createJobStore } from '../lib/job-store.js';
import { createLaneSelector } from '../lib/lane-selector.js';

function fakeSpineStateClient() {
  return {
    createJobEntity: async (urn) => ({ entity_urn: urn }),
    transitionJob: async () => ({}),
    getJobEntity: async () => null,
    listNonTerminalJobs: async () => [],
  };
}

function fakeApDrafter({ submitted = true, degraded = [], ap_ref = 'urn:apm:1', throws = false } = {}) {
  return {
    draftAP: async () => {
      if (throws) throw new Error('drafter_boom');
      return { submitted, ap_ref, risk_tier: 'medium', execution_plan: {}, degraded };
    },
  };
}

function fakeDispatcher({ dispatched = true, completed = true, throws = false } = {}) {
  const calls = [];
  return {
    calls,
    dispatchR0: async (args) => {
      calls.push({ method: 'r0', ...args });
      if (throws) throw new Error('dispatch_boom');
      return { dispatched, completed, results: [], failures: [] };
    },
  };
}

const TABLE = {
  actions: { 'Vigil:status': 'r0', 'Radiant:query': 'r0', 'Engram:ingest': 'write' },
  intake_heuristic: {
    r0_keywords: ['report', 'status', 'show'],
    write_keywords: ['create', 'update', 'ingest'],
  },
};

async function makeJob(lifecycle) {
  return lifecycle.createJob({ source: 'cortex', originator_ref: 'urn:test', reply_to: 'Cortex', priority: 'medium', description: 'test' });
}

test('R0 happy path: phase A returns r0 -> dispatchR0 called', async () => {
  const jobStore = createJobStore();
  const lifecycle = createJobLifecycle({ spineStateClient: fakeSpineStateClient(), jobStore });
  const job = await makeJob(lifecycle);
  // Enrich with R0-triggering description
  jobStore.update(job.job_urn, { description: 'show me the status report', intake_context: { kind: 'cortex_goal', target_state: 'show status report' } });

  const disp = fakeDispatcher();
  const planner = createPlanner({
    jobLifecycle: lifecycle,
    laneSelector: createLaneSelector({ table: TABLE }),
    apDrafter: fakeApDrafter(),
    dispatcher: disp,
  });

  const result = await planner.planAndDispatch(lifecycle.getJob(job.job_urn));
  assert.equal(result.planned, true);
  assert.equal(result.lane, 'r0');
  assert.equal(disp.calls.length, 1);
  assert.equal(disp.calls[0].method, 'r0');
});

test('write happy path: phase A returns pending -> apDrafter called', async () => {
  const jobStore = createJobStore();
  const lifecycle = createJobLifecycle({ spineStateClient: fakeSpineStateClient(), jobStore });
  const job = await makeJob(lifecycle);
  jobStore.update(job.job_urn, { description: 'something ambiguous', intake_context: { kind: 'cortex_goal', target_state: 'do something' } });

  const planner = createPlanner({
    jobLifecycle: lifecycle,
    laneSelector: createLaneSelector({ table: TABLE }),
    apDrafter: fakeApDrafter({ submitted: true }),
    dispatcher: fakeDispatcher(),
  });

  const result = await planner.planAndDispatch(lifecycle.getJob(job.job_urn));
  assert.equal(result.planned, true);
  assert.equal(result.lane, 'write');
  assert.equal(result.submitted, true);
});

test('drafter declines (mission absent) -> job fails', async () => {
  const jobStore = createJobStore();
  const lifecycle = createJobLifecycle({ spineStateClient: fakeSpineStateClient(), jobStore });
  const job = await makeJob(lifecycle);
  jobStore.update(job.job_urn, { description: 'create something', intake_context: { kind: 'cortex_goal', target_state: 'create it' } });

  const planner = createPlanner({
    jobLifecycle: lifecycle,
    laneSelector: createLaneSelector({ table: TABLE }),
    apDrafter: fakeApDrafter({ submitted: false, degraded: ['mission-fully-absent'] }),
    dispatcher: fakeDispatcher(),
  });

  const result = await planner.planAndDispatch(lifecycle.getJob(job.job_urn));
  assert.equal(result.planned, false);
  assert.equal(result.error, 'drafter_declined');
  // Job should be in a terminal state
  const finalJob = lifecycle.getJob(job.job_urn);
  assert.ok(['FAILED', 'DENIED'].includes(finalJob.state));
});

test('drafter throws -> job fails', async () => {
  const jobStore = createJobStore();
  const lifecycle = createJobLifecycle({ spineStateClient: fakeSpineStateClient(), jobStore });
  const job = await makeJob(lifecycle);
  jobStore.update(job.job_urn, { description: 'test', intake_context: { kind: 'cortex_goal', target_state: 'x' } });

  const planner = createPlanner({
    jobLifecycle: lifecycle,
    laneSelector: createLaneSelector({ table: TABLE }),
    apDrafter: fakeApDrafter({ throws: true }),
    dispatcher: fakeDispatcher(),
  });

  const result = await planner.planAndDispatch(lifecycle.getJob(job.job_urn));
  assert.equal(result.planned, false);
  assert.ok(result.error.includes('drafter_boom'));
});

test('R0 dispatch throws -> job fails', async () => {
  const jobStore = createJobStore();
  const lifecycle = createJobLifecycle({ spineStateClient: fakeSpineStateClient(), jobStore });
  const job = await makeJob(lifecycle);
  jobStore.update(job.job_urn, { description: 'show status', intake_context: { kind: 'cortex_goal', target_state: 'show status' } });

  const planner = createPlanner({
    jobLifecycle: lifecycle,
    laneSelector: createLaneSelector({ table: TABLE }),
    apDrafter: fakeApDrafter(),
    dispatcher: fakeDispatcher({ throws: true }),
  });

  const result = await planner.planAndDispatch(lifecycle.getJob(job.job_urn));
  assert.equal(result.planned, false);
});

test('deriveR0Targets covers report/search/question/default', () => {
  const { deriveR0Targets } = createPlanner({
    jobLifecycle: { getJob: () => null, markPlanning: async () => {}, setLane: () => {} },
    laneSelector: { selectLane: () => ({ lane: 'pending' }) },
    apDrafter: { draftAP: async () => ({}) },
    dispatcher: { dispatchR0: async () => ({}) },
  });
  assert.deepEqual(deriveR0Targets({ description: 'daily report', intake_context: {} }), ['Vigil:status']);
  assert.deepEqual(deriveR0Targets({ description: 'search logs', intake_context: {} }), ['Sourcegraph:search']);
  assert.deepEqual(deriveR0Targets({ description: 'x', intake_context: { intent_label: 'question' } }), ['Hippocampus:query', 'Radiant:query']);
  assert.deepEqual(deriveR0Targets({ description: 'unknown', intake_context: {} }), ['Radiant:query']);
});
