/**
 * CV: Live-loop health probes (unit-style).
 *
 * Validates that buildHealthCheck and buildIntrospectCheck return flat
 * objects conforming to the bug #9 contract:
 *   - healthCheck: no nested `checks` key, contains all probe fields +
 *     active_jobs, total_jobs, jobs_by_state, llm_available, mission_cache_loaded
 *   - introspectCheck: no nested `extra` key, contains total_jobs,
 *     jobs_by_state, dependencies_configured
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildHealthCheck, buildIntrospectCheck } from '../lib/health-probes.js';
import { createJobStore } from '../lib/job-store.js';

test('CV: healthCheck returns flat object with all required fields', async () => {
  const jobStore = createJobStore();

  // Seed some jobs to verify stats
  jobStore.add({ job_urn: 'urn:j:1', state: 'CREATED' });
  jobStore.add({ job_urn: 'urn:j:2', state: 'PLANNING' });
  jobStore.add({ job_urn: 'urn:j:3', state: 'SUCCEEDED' });

  const probes = {
    spine_state: true,
    nomos: true,
    cerberus: false,
    graph: true,
    arbiter: true,
    radiant: true,
    minder: false,
    hippocampus: true,
    syntra: true,
  };

  const check = buildHealthCheck({
    probes,
    jobStore,
    missionLoader: { peekCache: () => ({ msp: {}, bor: {} }) },
    llm: { isAvailable: () => true },
  });
  const result = await check();

  // FLAT: no nested `checks` key (bug #9)
  assert.equal(result.checks, undefined, 'healthCheck must not have nested checks key');

  // Probe fields present
  assert.equal(result.spine_state_reachable, true);
  assert.equal(result.nomos_reachable, true);
  assert.equal(result.cerberus_reachable, false);
  assert.equal(result.graph_reachable, true);
  assert.equal(result.arbiter_reachable, true);
  assert.equal(result.radiant_reachable, true);
  assert.equal(result.minder_reachable, false);
  assert.equal(result.hippocampus_reachable, true);
  assert.equal(result.syntra_reachable, true);

  // Job stats present
  assert.equal(typeof result.active_jobs, 'number');
  assert.equal(typeof result.total_jobs, 'number');
  assert.equal(result.total_jobs, 3);
  // active = total - (SUCCEEDED + DENIED + FAILED) = 3 - 1 = 2
  assert.equal(result.active_jobs, 2);
  assert.ok(result.jobs_by_state, 'jobs_by_state must be present');
  assert.equal(result.jobs_by_state.CREATED, 1);
  assert.equal(result.jobs_by_state.PLANNING, 1);
  assert.equal(result.jobs_by_state.SUCCEEDED, 1);

  // LLM + mission fields present
  assert.equal(result.llm_available, true);
  assert.equal(result.mission_cache_loaded, true);
});

test('CV: introspectCheck returns flat object with required fields', async () => {
  const jobStore = createJobStore();

  jobStore.add({ job_urn: 'urn:j:i1', state: 'DISPATCHED' });
  jobStore.add({ job_urn: 'urn:j:i2', state: 'EXECUTING' });

  const check = buildIntrospectCheck({
    jobStore,
    missionLoader: { peekCache: () => null },
    dependencies: ['Spine'],
  });
  const result = await check();

  // FLAT: no nested `extra` key (bug #9)
  assert.equal(result.extra, undefined, 'introspectCheck must not have nested extra key');

  // Required fields
  assert.equal(result.total_jobs, 2);
  assert.ok(result.jobs_by_state, 'jobs_by_state must be present');
  assert.equal(result.jobs_by_state.DISPATCHED, 1);
  assert.equal(result.jobs_by_state.EXECUTING, 1);
  assert.equal(result.mission_cache_loaded, false);
  assert.deepEqual(result.dependencies_configured, ['Spine']);
});

test('CV: healthCheck with zero jobs and no LLM reports correctly', async () => {
  const jobStore = createJobStore();
  const probes = {
    spine_state: false,
    nomos: false,
    cerberus: false,
    graph: false,
    arbiter: false,
    radiant: false,
    minder: false,
    hippocampus: false,
    syntra: false,
  };

  const check = buildHealthCheck({
    probes,
    jobStore,
    missionLoader: { peekCache: () => null },
    llm: { isAvailable: () => false },
  });
  const result = await check();

  assert.equal(result.total_jobs, 0);
  assert.equal(result.active_jobs, 0);
  assert.equal(result.llm_available, false);
  assert.equal(result.mission_cache_loaded, false);
  assert.equal(result.spine_state_reachable, false);
});
