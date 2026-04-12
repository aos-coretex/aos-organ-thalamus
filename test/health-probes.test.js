import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildHealthCheck, buildIntrospectCheck } from '../lib/health-probes.js';
import { createJobStore } from '../lib/job-store.js';

test('healthCheck returns flat object with probe fields', async () => {
  const jobStore = createJobStore();
  const probes = { spine_state: true, nomos: false, cerberus: true, graph: true, arbiter: false, radiant: true, minder: true, hippocampus: false, syntra: true };
  const check = buildHealthCheck({ probes, jobStore, missionLoader: { peekCache: () => null }, llm: { isAvailable: () => true } });
  const result = await check();

  assert.equal(result.spine_state_reachable, true);
  assert.equal(result.nomos_reachable, false);
  assert.equal(result.llm_available, true);
  assert.equal(result.mission_cache_loaded, false);
  assert.equal(result.total_jobs, 0);
  assert.ok(result.jobs_by_state);
  // Ensure it's FLAT — no nested `checks` wrapper
  assert.equal(result.checks, undefined);
});

test('introspectCheck returns flat object', async () => {
  const jobStore = createJobStore();
  const check = buildIntrospectCheck({ jobStore, missionLoader: { peekCache: () => ({ msp: {} }) }, dependencies: ['Spine'] });
  const result = await check();

  assert.equal(result.total_jobs, 0);
  assert.equal(result.mission_cache_loaded, true);
  assert.deepEqual(result.dependencies_configured, ['Spine']);
  assert.equal(result.extra, undefined);
});
