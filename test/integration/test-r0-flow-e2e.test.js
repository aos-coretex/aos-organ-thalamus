/**
 * MP-16 v6t-1: R0 Flow End-to-End Integration Test
 *
 * Verifies the R0 (read-only) message flow using a REAL Spine organ
 * (in-memory SQLite) and real Thalamus spine-state-client. No mocks
 * on Spine state machine or message routing.
 *
 * What's tested:
 *   - spine-state-client talks to real Spine /state/* endpoints
 *   - Job lifecycle: CREATED -> PLANNING -> DISPATCHED -> EXECUTING -> SUCCEEDED
 *   - No AWAITING_AUTH state (R0 bypasses governance)
 *   - No governance messages (APM, PEM, ATM, HOM) in Spine event log
 *   - State transition OTM broadcasts emitted for each job transition
 *   - Job lifecycle module (Thalamus) creates entities on real Spine
 *
 * Department organs are NOT running — R0 dispatch returns failures.
 * The test verifies the plumbing, not the department organ response.
 */

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import { createSpineStateClient } from '../../lib/spine-state-client.js';
import { createJobLifecycle } from '../../lib/job-lifecycle.js';
import { createJobStore } from '../../lib/job-store.js';

// --- Spine bootstrap: start the real Spine server in a subprocess ---
let spineProcess;
let spinePort;
let spineUrl;

async function waitForSpine(url, maxWaitMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    try {
      const res = await fetch(`${url}/health`);
      if (res.ok) return true;
    } catch { /* not ready yet */ }
    await new Promise(r => setTimeout(r, 200));
  }
  return false;
}

before(async () => {
  // Start Spine as a child process on a fixed test port
  const { spawn } = await import('node:child_process');
  spinePort = 14000 + Math.floor(Math.random() * 1000);
  spineUrl = `http://127.0.0.1:${spinePort}`;

  const spineSrc = new URL('../../../../AOS-organ-spine/AOS-organ-spine-src', import.meta.url).pathname;

  spineProcess = spawn(process.execPath, ['server/index.js'], {
    cwd: spineSrc,
    env: {
      ...process.env,
      SPINE_PORT: String(spinePort),
      SPINE_DB_PATH: ':memory:',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  // Wait for Spine to be ready
  const ready = await waitForSpine(spineUrl);
  if (!ready) throw new Error(`Spine failed to start on port ${spinePort}`);
});

after(async () => {
  if (spineProcess) {
    spineProcess.kill('SIGTERM');
    await new Promise(r => setTimeout(r, 500));
  }
});

// --- Helper: query Spine events ---
async function querySpineEvents(type) {
  const res = await fetch(`${spineUrl}/events?type=${type}`);
  return res.json();
}

async function querySpineState(entityUrn) {
  const encoded = encodeURIComponent(entityUrn);
  const res = await fetch(`${spineUrl}/state/${encoded}`);
  if (res.status === 404) return null;
  return res.json();
}

describe('MP-16 v6t-1: R0 flow integration with real Spine', () => {

  test('spine-state-client creates job entity on real Spine', async () => {
    const client = createSpineStateClient({ spineUrl, timeoutMs: 5000 });

    const jobUrn = `urn:llm-ops:job:test-r0-create-${Date.now()}`;
    const result = await client.createJobEntity(jobUrn, { source: 'receptor', created_by: 'Thalamus' });

    assert.equal(result.entity_urn, jobUrn);
    assert.equal(result.entity_type, 'job');
    assert.equal(result.current_state, 'CREATED');

    // Verify via direct Spine query
    const entity = await querySpineState(jobUrn);
    assert.ok(entity, 'entity must exist in spine-state');
    assert.equal(entity.current_state, 'CREATED');
  });

  test('spine-state transitions follow R0 path (no AWAITING_AUTH)', async () => {
    const client = createSpineStateClient({ spineUrl, timeoutMs: 5000 });

    const jobUrn = `urn:llm-ops:job:test-r0-transitions-${Date.now()}`;
    await client.createJobEntity(jobUrn, { source: 'receptor' });

    // R0 path: CREATED -> PLANNING -> DISPATCHED -> EXECUTING -> SUCCEEDED
    await client.transitionJob(jobUrn, 'CREATED', 'PLANNING', 'planning_started');
    await client.transitionJob(jobUrn, 'PLANNING', 'DISPATCHED', 'r0_fast_path');
    await client.transitionJob(jobUrn, 'DISPATCHED', 'EXECUTING', 'r0_dispatch');
    await client.transitionJob(jobUrn, 'EXECUTING', 'SUCCEEDED', 'r0_completed');

    // Verify final state
    const entity = await querySpineState(jobUrn);
    assert.equal(entity.current_state, 'SUCCEEDED');

    // Verify full history — no AWAITING_AUTH
    const states = entity.history.map(h => h.to_state);
    assert.deepEqual(states, ['PLANNING', 'DISPATCHED', 'EXECUTING', 'SUCCEEDED']);
    assert.ok(!states.includes('AWAITING_AUTH'), 'R0 path must not enter AWAITING_AUTH');
  });

  test('PLANNING -> DISPATCHED is valid (R0 fast path skips AWAITING_AUTH)', async () => {
    const client = createSpineStateClient({ spineUrl, timeoutMs: 5000 });

    const jobUrn = `urn:llm-ops:job:test-r0-fast-${Date.now()}`;
    await client.createJobEntity(jobUrn, { source: 'receptor' });
    await client.transitionJob(jobUrn, 'CREATED', 'PLANNING', 'test');

    // R0 fast path: PLANNING -> DISPATCHED is valid
    await client.transitionJob(jobUrn, 'PLANNING', 'DISPATCHED', 'r0_fast_path');

    const entity = await querySpineState(jobUrn);
    assert.equal(entity.current_state, 'DISPATCHED');
    assert.ok(!entity.history.some(h => h.to_state === 'AWAITING_AUTH'),
      'R0 job must never enter AWAITING_AUTH');
  });

  test('state_transition OTM broadcasts emitted for each job transition', async () => {
    const client = createSpineStateClient({ spineUrl, timeoutMs: 5000 });

    const jobUrn = `urn:llm-ops:job:test-r0-broadcasts-${Date.now()}`;
    await client.createJobEntity(jobUrn, { source: 'receptor' });

    await client.transitionJob(jobUrn, 'CREATED', 'PLANNING', 'test');
    await client.transitionJob(jobUrn, 'PLANNING', 'DISPATCHED', 'test');
    await client.transitionJob(jobUrn, 'DISPATCHED', 'EXECUTING', 'test');
    await client.transitionJob(jobUrn, 'EXECUTING', 'SUCCEEDED', 'test');

    // Check that state_transition OTMs were broadcast
    const allEvents = await querySpineEvents('OTM');
    const jobTransitions = allEvents.events.filter(e =>
      e.envelope?.payload?.event_type === 'state_transition' &&
      e.envelope?.payload?.data?.entity_urn === jobUrn
    );

    assert.equal(jobTransitions.length, 4, 'must emit 4 state_transition OTM broadcasts');

    for (const event of jobTransitions) {
      assert.equal(event.envelope.target_organ, '*', 'state_transition must be broadcast');
      assert.equal(event.envelope.source_organ, 'Spine', 'state_transition emitted by Spine');
      assert.equal(event.routing, 'broadcast');
    }

    // Verify the transition sequence in the broadcasts
    const broadcastStates = jobTransitions.map(e => e.envelope.payload.data.current_state);
    assert.ok(broadcastStates.includes('PLANNING'));
    assert.ok(broadcastStates.includes('DISPATCHED'));
    assert.ok(broadcastStates.includes('EXECUTING'));
    assert.ok(broadcastStates.includes('SUCCEEDED'));
  });

  test('no governance messages (APM, PEM, ATM, HOM) in Spine during R0 flow', async () => {
    const apm = await querySpineEvents('APM');
    const pem = await querySpineEvents('PEM');
    const atm = await querySpineEvents('ATM');
    const hom = await querySpineEvents('HOM');

    assert.equal(apm.count, 0, 'R0 flow must produce zero APM messages');
    assert.equal(pem.count, 0, 'R0 flow must produce zero PEM messages');
    assert.equal(atm.count, 0, 'R0 flow must produce zero ATM messages');
    assert.equal(hom.count, 0, 'R0 flow must produce zero HOM messages');
  });

  test('job lifecycle module creates R0 job via real Spine', async () => {
    const client = createSpineStateClient({ spineUrl, timeoutMs: 5000 });
    const jobStore = createJobStore();
    const lifecycle = createJobLifecycle({ spineStateClient: client, jobStore });

    const job = await lifecycle.createJob({
      source: 'receptor',
      originator_ref: 'urn:llm-ops:otm:test-r0-lifecycle',
      reply_to: 'Receptor',
      priority: 'medium',
      description: 'MP-16 v6t-1 R0 lifecycle integration test',
    });

    assert.ok(job.job_urn, 'job must have a URN');
    assert.equal(job.state, 'CREATED');

    // Transition through R0 planning
    await lifecycle.markPlanning(job.job_urn);
    lifecycle.setLane(job.job_urn, 'r0');

    const planned = jobStore.get(job.job_urn);
    assert.equal(planned.state, 'PLANNING');
    assert.equal(planned.lane, 'r0');

    // Verify in real Spine
    const entity = await querySpineState(job.job_urn);
    assert.ok(entity, 'job entity must exist in real spine-state');
    assert.equal(entity.current_state, 'PLANNING');
  });

  test('Spine POST /messages rejects governance types as broadcast', async () => {
    // Governance messages (APM, PEM, ATM, HOM) must not be broadcast
    const envelope = {
      type: 'APM',
      source_organ: 'Thalamus',
      target_organ: '*',
      payload: { action: 'test', targets: [], risk_tier: 'low', evidence_refs: [], rollback_plan: 'none', reason: 'test' },
    };

    const res = await fetch(`${spineUrl}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(envelope),
    });

    assert.equal(res.status, 400, 'governance types must not be broadcastable');
    const body = await res.json();
    assert.ok(body.error, 'must return error for governance broadcast');
  });
});
