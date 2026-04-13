/**
 * MP-16 v6t-2: Write-Lane Flow End-to-End Integration Test
 *
 * Verifies the write-lane governance chain using a REAL Spine
 * (in-memory SQLite) and real Thalamus spine-state-client + job lifecycle.
 *
 * What's tested:
 *   - Write-lane state machine: CREATED → PLANNING → AWAITING_AUTH → DISPATCHED → EXECUTING → SUCCEEDED
 *   - AWAITING_AUTH is entered (unlike R0 which skips it)
 *   - APM message type: directed routing only (cannot broadcast)
 *   - ATM message type: directed routing only (cannot broadcast)
 *   - correlation_id propagation across APM → ATM → OTM chain
 *   - Token concept lifecycle via spine-state
 *   - Governance messages accumulate in Spine audit trail
 *   - DENIED state reachable from AWAITING_AUTH
 *   - Infrastructure exemption: OTM can be broadcast (governance types cannot)
 *
 * Live multi-organ verification found:
 *   - APM routes correctly: Thalamus → Spine → Nomos mailbox
 *   - Nomos adjudicates and queries Arbiter HTTP /scope-query
 *   - Ruling broadcast (OTM ruling_issued) emitted
 *   - AP drafter requires LLM (blocked without API key)
 */

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createSpineStateClient } from '../../lib/spine-state-client.js';
import { createJobLifecycle } from '../../lib/job-lifecycle.js';
import { createJobStore } from '../../lib/job-store.js';

let spineProcess;
let spinePort;
let spineUrl;

async function waitForSpine(url, maxWaitMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    try {
      const res = await fetch(`${url}/health`);
      if (res.ok) return true;
    } catch { /* not ready */ }
    await new Promise(r => setTimeout(r, 200));
  }
  return false;
}

before(async () => {
  const { spawn } = await import('node:child_process');
  spinePort = 15000 + Math.floor(Math.random() * 1000);
  spineUrl = `http://127.0.0.1:${spinePort}`;

  const spineSrc = new URL('../../../../AOS-organ-spine/AOS-organ-spine-src', import.meta.url).pathname;

  spineProcess = spawn(process.execPath, ['server/index.js'], {
    cwd: spineSrc,
    env: { ...process.env, SPINE_PORT: String(spinePort), SPINE_DB_PATH: ':memory:' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const ready = await waitForSpine(spineUrl);
  if (!ready) throw new Error(`Spine failed to start on port ${spinePort}`);
});

after(async () => {
  if (spineProcess) {
    spineProcess.kill('SIGTERM');
    await new Promise(r => setTimeout(r, 500));
  }
});

async function postMessage(envelope) {
  const res = await fetch(`${spineUrl}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(envelope),
  });
  return { status: res.status, body: await res.json() };
}

async function queryEvents(type) {
  const res = await fetch(`${spineUrl}/events?type=${type}`);
  return res.json();
}

async function queryState(entityUrn) {
  const encoded = encodeURIComponent(entityUrn);
  const res = await fetch(`${spineUrl}/state/${encoded}`);
  if (res.status === 404) return null;
  return res.json();
}

describe('MP-16 v6t-2: Write-lane governance chain with real Spine', () => {

  test('write-lane state machine: CREATED → PLANNING → AWAITING_AUTH → DISPATCHED → EXECUTING → SUCCEEDED', async () => {
    const client = createSpineStateClient({ spineUrl, timeoutMs: 5000 });

    const jobUrn = `urn:llm-ops:job:test-write-lane-${Date.now()}`;
    await client.createJobEntity(jobUrn, { source: 'receptor', lane: 'write' });

    // Full write-lane path
    await client.transitionJob(jobUrn, 'CREATED', 'PLANNING', 'planning_started');
    await client.transitionJob(jobUrn, 'PLANNING', 'AWAITING_AUTH', 'ap_submitted_to_nomos');
    await client.transitionJob(jobUrn, 'AWAITING_AUTH', 'DISPATCHED', 'atm_received_from_nomos');
    await client.transitionJob(jobUrn, 'DISPATCHED', 'EXECUTING', 'cerberus_executing');
    await client.transitionJob(jobUrn, 'EXECUTING', 'SUCCEEDED', 'execution_completed');

    const entity = await queryState(jobUrn);
    assert.equal(entity.current_state, 'SUCCEEDED');

    const states = entity.history.map(h => h.to_state);
    assert.deepEqual(states, ['PLANNING', 'AWAITING_AUTH', 'DISPATCHED', 'EXECUTING', 'SUCCEEDED']);
    assert.ok(states.includes('AWAITING_AUTH'), 'write-lane MUST enter AWAITING_AUTH');
  });

  test('AWAITING_AUTH → DENIED is valid (Nomos denial)', async () => {
    const client = createSpineStateClient({ spineUrl, timeoutMs: 5000 });

    const jobUrn = `urn:llm-ops:job:test-denial-${Date.now()}`;
    await client.createJobEntity(jobUrn, { source: 'receptor', lane: 'write' });

    await client.transitionJob(jobUrn, 'CREATED', 'PLANNING', 'planning_started');
    await client.transitionJob(jobUrn, 'PLANNING', 'AWAITING_AUTH', 'ap_submitted');
    await client.transitionJob(jobUrn, 'AWAITING_AUTH', 'DENIED', 'nomos_denied_scope_out');

    const entity = await queryState(jobUrn);
    assert.equal(entity.current_state, 'DENIED');
    assert.ok(entity.history.some(h => h.to_state === 'AWAITING_AUTH'));
    assert.ok(entity.history.some(h => h.to_state === 'DENIED'));
  });

  test('APM message type: Spine routes directed APM to target mailbox', async () => {
    // Register a mailbox for "Nomos"
    await fetch(`${spineUrl}/mailbox/Nomos`, { method: 'POST' });

    const correlationId = `urn:llm-ops:correlation:apm-test-${Date.now()}`;
    const result = await postMessage({
      type: 'APM',
      source_organ: 'Thalamus',
      target_organ: 'Nomos',
      correlation_id: correlationId,
      reply_to: 'Thalamus',
      payload: {
        action: 'Create MP-16 test concept',
        targets: ['urn:test:concept'],
        risk_tier: 'low',
        evidence_refs: ['urn:test:evidence'],
        rollback_plan: 'Delete concept',
        reason: 'Integration test',
      },
    });

    assert.equal(result.status, 202, 'Spine must accept directed APM');
    assert.equal(result.body.routing, 'directed');
    assert.ok(result.body.message_id, 'Spine must assign message_id');

    // Verify APM in audit trail
    const events = await queryEvents('APM');
    assert.ok(events.count >= 1, 'APM must appear in Spine event log');

    const apm = events.events.find(e => e.envelope?.correlation_id === correlationId);
    assert.ok(apm, 'APM with our correlation_id must exist in audit');
    assert.equal(apm.source_organ, 'Thalamus');
    assert.equal(apm.target_organ, 'Nomos');
    assert.equal(apm.routing, 'directed');

    // Verify in Nomos mailbox
    const drainRes = await fetch(`${spineUrl}/mailbox/Nomos/drain`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ limit: 10 }),
    });
    const drained = await drainRes.json();
    const apmMsg = drained.messages.find(m => m.correlation_id === correlationId);
    assert.ok(apmMsg, 'APM must be deliverable from Nomos mailbox');
    assert.equal(apmMsg.type, 'APM');
    assert.equal(apmMsg.payload.action, 'Create MP-16 test concept');
  });

  test('APM cannot be broadcast (governance protection)', async () => {
    const result = await postMessage({
      type: 'APM',
      source_organ: 'Thalamus',
      target_organ: '*',
      payload: {
        action: 'test', targets: [], risk_tier: 'low',
        evidence_refs: [], rollback_plan: 'n/a', reason: 'test',
      },
    });

    assert.equal(result.status, 400, 'APM broadcast must be rejected');
    assert.ok(result.body.error, 'error field must be present');
  });

  test('ATM message type: Spine routes directed ATM', async () => {
    await fetch(`${spineUrl}/mailbox/Thalamus`, { method: 'POST' });

    const correlationId = `urn:llm-ops:correlation:atm-test-${Date.now()}`;
    const tokenUrn = `urn:llm-ops:token:test-${Date.now()}`;

    const result = await postMessage({
      type: 'ATM',
      source_organ: 'Nomos',
      target_organ: 'Thalamus',
      correlation_id: correlationId,
      reply_to: 'Nomos',
      payload: {
        token_urn: tokenUrn,
        scope: {
          targets: ['urn:test:concept'],
          action_types: ['graph_concept_upsert'],
          ttl_seconds: 3600,
          conditions: [],
        },
        ap_ref: 'urn:llm-ops:apm:test-ref',
      },
    });

    assert.equal(result.status, 202, 'Spine must accept directed ATM');
    assert.equal(result.body.routing, 'directed');

    // Verify ATM in audit trail
    const events = await queryEvents('ATM');
    assert.ok(events.count >= 1, 'ATM must appear in Spine event log');

    const atm = events.events.find(e => e.envelope?.correlation_id === correlationId);
    assert.ok(atm, 'ATM with our correlation_id must exist');
    assert.equal(atm.source_organ, 'Nomos');
    assert.equal(atm.target_organ, 'Thalamus');
  });

  test('ATM cannot be broadcast (governance protection)', async () => {
    const result = await postMessage({
      type: 'ATM',
      source_organ: 'Nomos',
      target_organ: '*',
      payload: {
        token_urn: 'urn:test', scope: { targets: [], action_types: [], ttl_seconds: 60 },
        ap_ref: 'urn:test',
      },
    });

    assert.equal(result.status, 400, 'ATM broadcast must be rejected');
  });

  test('HOM cannot be broadcast (governance protection)', async () => {
    const result = await postMessage({
      type: 'HOM',
      source_organ: 'Arbiter',
      target_organ: '*',
      payload: {
        decision_type: 'bor_ambiguity', context: 'test',
        question: 'test?', options: ['yes', 'no'],
      },
    });

    assert.equal(result.status, 400, 'HOM broadcast must be rejected');
  });

  test('PEM cannot be broadcast (governance protection)', async () => {
    const result = await postMessage({
      type: 'PEM',
      source_organ: 'Nomos',
      target_organ: '*',
      payload: {
        conflict_class: 'MSP_CONFLICT', blocked_action: 'test',
        blocking_rules: [], necessity: 'test', proposed_change: 'test',
        risk_assessment: 'low',
      },
    });

    assert.equal(result.status, 400, 'PEM broadcast must be rejected');
  });

  test('OTM CAN broadcast (only OTM is broadcastable)', async () => {
    const result = await postMessage({
      type: 'OTM',
      source_organ: 'Nomos',
      target_organ: '*',
      payload: {
        event_type: 'ruling_issued',
        ruling_id: 'urn:test:ruling',
        ruling: 'Authorized',
      },
    });

    assert.equal(result.status, 202, 'OTM broadcast must be accepted');
    assert.equal(result.body.routing, 'broadcast');
  });

  test('correlation_id propagation across APM → ATM → OTM chain', async () => {
    await fetch(`${spineUrl}/mailbox/Nomos`, { method: 'POST' });
    await fetch(`${spineUrl}/mailbox/Thalamus`, { method: 'POST' });
    await fetch(`${spineUrl}/mailbox/Cerberus`, { method: 'POST' });

    // Single correlation_id for the entire chain
    const correlationId = `urn:llm-ops:correlation:chain-test-${Date.now()}`;

    // 1. APM: Thalamus → Nomos
    const apmResult = await postMessage({
      type: 'APM',
      source_organ: 'Thalamus',
      target_organ: 'Nomos',
      correlation_id: correlationId,
      reply_to: 'Thalamus',
      payload: {
        action: 'test chain', targets: ['urn:test'], risk_tier: 'low',
        evidence_refs: [], rollback_plan: 'n/a', reason: 'chain test',
      },
    });
    assert.equal(apmResult.status, 202);

    // 2. ATM: Nomos → Thalamus (response with same correlation_id)
    const atmResult = await postMessage({
      type: 'ATM',
      source_organ: 'Nomos',
      target_organ: 'Thalamus',
      correlation_id: correlationId,
      reply_to: 'Nomos',
      payload: {
        token_urn: `urn:llm-ops:token:chain-${Date.now()}`,
        scope: { targets: ['urn:test'], action_types: ['graph_concept_upsert'], ttl_seconds: 3600 },
        ap_ref: apmResult.body.message_id,
      },
    });
    assert.equal(atmResult.status, 202);

    // 3. ATM: Thalamus → Cerberus (forwarded with same correlation_id)
    const fwdResult = await postMessage({
      type: 'ATM',
      source_organ: 'Thalamus',
      target_organ: 'Cerberus',
      correlation_id: correlationId,
      reply_to: 'Thalamus',
      payload: {
        token_urn: `urn:llm-ops:token:chain-${Date.now()}`,
        scope: { targets: ['urn:test'], action_types: ['graph_concept_upsert'], ttl_seconds: 3600 },
        ap_ref: apmResult.body.message_id,
        execution_request: {
          targets: ['urn:test'],
          action_type: 'graph_concept_upsert',
          payload: { concept_urn: 'urn:test', concept_type: 'test', concept_data: {} },
        },
      },
    });
    assert.equal(fwdResult.status, 202);

    // 4. OTM: Cerberus → * (execution_completed broadcast with same correlation_id)
    const broadcastResult = await postMessage({
      type: 'OTM',
      source_organ: 'Cerberus',
      target_organ: '*',
      correlation_id: correlationId,
      payload: {
        event_type: 'execution_completed',
        execution_id: `urn:llm-ops:execution:chain-${Date.now()}`,
        token_urn: `urn:llm-ops:token:chain`,
        status: 'executed',
      },
    });
    assert.equal(broadcastResult.status, 202);

    // Verify ALL messages in Spine audit trail share the correlation_id
    const allEvents = [];
    for (const type of ['APM', 'ATM', 'OTM']) {
      const events = await queryEvents(type);
      allEvents.push(...events.events.filter(e => e.envelope?.correlation_id === correlationId));
    }

    // Should have: 1 APM + 2 ATMs + 1 OTM = 4 messages
    assert.ok(allEvents.length >= 4, `Expected 4+ messages with correlation_id, got ${allEvents.length}`);

    // Verify message types present
    const types = allEvents.map(e => e.message_type);
    assert.ok(types.includes('APM'), 'chain must include APM');
    assert.ok(types.includes('ATM'), 'chain must include ATM');
    assert.ok(types.includes('OTM'), 'chain must include OTM');

    // Verify all share the same correlation_id
    for (const event of allEvents) {
      assert.equal(event.envelope.correlation_id, correlationId,
        `All messages must share correlation_id. Got ${event.envelope.correlation_id} for ${event.message_type}`);
    }
  });

  test('write-lane job lifecycle with real Spine state machine', async () => {
    const client = createSpineStateClient({ spineUrl, timeoutMs: 5000 });
    const jobStore = createJobStore();
    const lifecycle = createJobLifecycle({ spineStateClient: client, jobStore });

    // Create job for write-lane
    const job = await lifecycle.createJob({
      source: 'receptor',
      originator_ref: 'urn:llm-ops:otm:test-write-lifecycle',
      reply_to: 'Receptor',
      priority: 'high',
      description: 'MP-16 v6t-2 write-lane lifecycle test',
    });

    assert.equal(job.state, 'CREATED');

    // Plan
    await lifecycle.markPlanning(job.job_urn);
    lifecycle.setLane(job.job_urn, 'write');

    const planned = jobStore.get(job.job_urn);
    assert.equal(planned.state, 'PLANNING');
    assert.equal(planned.lane, 'write');

    // Submit AP → await auth (markAwaitingAuth requires AP metadata)
    await lifecycle.markAwaitingAuth(job.job_urn, {
      ap_ref: 'urn:llm-ops:apm:test-write-lifecycle-ap',
      risk_tier: 'low',
      rollback_plan: 'Delete test concept',
      targets: ['urn:test:concept'],
      evidence_refs: ['urn:test:evidence'],
      mission_frame_ref: null,
      execution_plan: { action_type: 'graph_concept_upsert' },
    });
    assert.equal(jobStore.get(job.job_urn).state, 'AWAITING_AUTH');

    // Verify in real Spine
    const entity = await queryState(job.job_urn);
    assert.equal(entity.current_state, 'AWAITING_AUTH');
    assert.ok(entity.history.some(h => h.to_state === 'AWAITING_AUTH'),
      'write-lane job must pass through AWAITING_AUTH in spine-state');
  });

  test('state_transition broadcasts include AWAITING_AUTH for write-lane', async () => {
    const client = createSpineStateClient({ spineUrl, timeoutMs: 5000 });

    const jobUrn = `urn:llm-ops:job:test-write-broadcasts-${Date.now()}`;
    await client.createJobEntity(jobUrn, { source: 'receptor', lane: 'write' });

    await client.transitionJob(jobUrn, 'CREATED', 'PLANNING', 'test');
    await client.transitionJob(jobUrn, 'PLANNING', 'AWAITING_AUTH', 'ap_submitted');
    await client.transitionJob(jobUrn, 'AWAITING_AUTH', 'DISPATCHED', 'atm_received');
    await client.transitionJob(jobUrn, 'DISPATCHED', 'EXECUTING', 'cerberus');
    await client.transitionJob(jobUrn, 'EXECUTING', 'SUCCEEDED', 'done');

    const allEvents = await queryEvents('OTM');
    const transitions = allEvents.events.filter(e =>
      e.envelope?.payload?.event_type === 'state_transition' &&
      e.envelope?.payload?.data?.entity_urn === jobUrn
    );

    assert.equal(transitions.length, 5, 'write-lane must emit 5 state_transition broadcasts');

    const broadcastStates = transitions.map(e => e.envelope.payload.data.current_state);
    assert.ok(broadcastStates.includes('AWAITING_AUTH'),
      'AWAITING_AUTH transition must be broadcast (distinguishes write from R0)');
    assert.ok(broadcastStates.includes('SUCCEEDED'));
  });

  test('Spine assigns unique message_id to every message (never reuses)', async () => {
    const ids = new Set();

    for (let i = 0; i < 5; i++) {
      const result = await postMessage({
        type: 'OTM',
        source_organ: 'Thalamus',
        target_organ: '*',
        payload: { event_type: 'test_uniqueness', iteration: i },
      });
      assert.ok(!ids.has(result.body.message_id), `message_id must be unique (iteration ${i})`);
      ids.add(result.body.message_id);
    }

    assert.equal(ids.size, 5, 'all 5 message_ids must be unique');
  });
});
