/**
 * MP-16 v6t-3: PEM + BoR Escalation End-to-End Integration Test
 *
 * Verifies PEM and HOM message routing, governance broadcast constraints,
 * pem_resolved closure pattern, and all 5 DIO message types against a REAL
 * Spine (in-memory SQLite).
 *
 * Test Case A: MSP_CONFLICT — PEM directed to Senate, governance broadcasts
 * Test Case B: BOR_CONFLICT — PEM + HOM routing, all 5 types exercised
 *
 * Live multi-organ findings:
 *   - PEM routed correctly: Nomos → Spine → Senate mailbox
 *   - Senate processed PEM, created escalation record, attempted LLM draft
 *   - Scope-violation guard correctly blocked degraded draft (no LLM)
 *   - Senate used direct HTTP to Arbiter for BOR proposals
 */

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';

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
  spinePort = 16000 + Math.floor(Math.random() * 1000);
  spineUrl = `http://127.0.0.1:${spinePort}`;

  const spineSrc = new URL('../../../../AOS-organ-spine/AOS-organ-spine-src', import.meta.url).pathname;

  spineProcess = spawn(process.execPath, ['server/index.js'], {
    cwd: spineSrc,
    env: { ...process.env, SPINE_PORT: String(spinePort), SPINE_DB_PATH: ':memory:' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const ready = await waitForSpine(spineUrl);
  if (!ready) throw new Error(`Spine failed to start on port ${spinePort}`);

  // Register mailboxes for governance organs
  for (const organ of ['Nomos', 'Senate', 'Thalamus', 'Arbiter', 'Cerberus', 'Human_Principal']) {
    await fetch(`${spineUrl}/mailbox/${organ}`, { method: 'POST' });
  }

  // Human_Principal is not in the 29-organ manifest — provision it
  // so Spine routing accepts directed messages to it
  await fetch(`${spineUrl}/manifest/Human_Principal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ required: false }),
  });
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

async function drainMailbox(organName) {
  const res = await fetch(`${spineUrl}/mailbox/${organName}/drain`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ limit: 50 }),
  });
  return res.json();
}

describe('MP-16 v6t-3: PEM + BoR escalation with real Spine', () => {

  // ─── Test Case A: MSP_CONFLICT PEM Flow ───

  describe('Test Case A: MSP_CONFLICT', () => {

    test('PEM routes from Nomos to Senate via Spine (directed)', async () => {
      const correlationId = `urn:llm-ops:correlation:pem-msp-${Date.now()}`;
      const result = await postMessage({
        type: 'PEM',
        source_organ: 'Nomos',
        target_organ: 'Senate',
        correlation_id: correlationId,
        reply_to: 'Nomos',
        payload: {
          conflict_class: 'MSP_CONFLICT',
          blocked_action: 'urn:llm-ops:apm:test-blocked',
          blocking_rules: ['MSP-001'],
          necessity: 'MP-16 verification',
          proposed_change: 'Allow test writes',
          risk_assessment: 'Low',
        },
      });

      assert.equal(result.status, 202, 'Spine must accept directed PEM');
      assert.equal(result.body.routing, 'directed');
      assert.equal(result.body.target_organ, 'Senate');

      // Verify PEM in audit trail
      const events = await queryEvents('PEM');
      assert.ok(events.count >= 1, 'PEM must appear in Spine audit trail');
      const pem = events.events.find(e => e.envelope?.correlation_id === correlationId);
      assert.ok(pem, 'PEM with our correlation_id must exist');
      assert.equal(pem.source_organ, 'Nomos');
      assert.equal(pem.target_organ, 'Senate');

      // Verify deliverable from Senate mailbox
      const drained = await drainMailbox('Senate');
      const pemMsg = drained.messages.find(m => m.correlation_id === correlationId);
      assert.ok(pemMsg, 'PEM must be in Senate mailbox');
      assert.equal(pemMsg.type, 'PEM');
      assert.equal(pemMsg.payload.conflict_class, 'MSP_CONFLICT');
    });

    test('pem_resolved OTM routes from Senate back to Nomos (directed)', async () => {
      const correlationId = `urn:llm-ops:correlation:pem-resolved-${Date.now()}`;
      const perRef = `urn:llm-ops:pem:test-resolved-${Date.now()}`;

      // Simulate Senate emitting pem_resolved after review
      const result = await postMessage({
        type: 'OTM',
        source_organ: 'Senate',
        target_organ: 'Nomos',
        correlation_id: correlationId,
        reply_to: 'Senate',
        payload: {
          event_type: 'pem_resolved',
          per_ref: perRef,
          resolution: 'amended',
          new_msp_urn: 'urn:graphheight:msp_version:1.0.1',
          new_msp_version: '1.0.1',
          draft_id: 'urn:graphheight:amendment_draft:test',
          resolved_at: new Date().toISOString(),
        },
      });

      assert.equal(result.status, 202);
      assert.equal(result.body.routing, 'directed');

      // Verify Nomos receives pem_resolved
      const drained = await drainMailbox('Nomos');
      const resolved = drained.messages.find(m => m.payload?.event_type === 'pem_resolved');
      assert.ok(resolved, 'pem_resolved must be in Nomos mailbox');
      assert.equal(resolved.payload.resolution, 'amended');
      assert.equal(resolved.payload.per_ref, perRef);
    });

    test('governance broadcasts (msp_updated) are OTM type and broadcastable', async () => {
      // Senate emits msp_updated as OTM broadcast (not a governance type)
      const result = await postMessage({
        type: 'OTM',
        source_organ: 'Senate',
        target_organ: '*',
        payload: {
          event_type: 'msp_updated',
          msp_urn: 'urn:graphheight:msp_version:1.0.1',
          version: '1.0.1',
          hash: 'abc123',
          activated_at: new Date().toISOString(),
          previous_version: '1.0.0-seed',
          bootstrap: false,
        },
      });

      assert.equal(result.status, 202);
      assert.equal(result.body.routing, 'broadcast');
    });

    test('governance_version_activated broadcast is OTM type', async () => {
      const result = await postMessage({
        type: 'OTM',
        source_organ: 'Senate',
        target_organ: '*',
        payload: {
          event_type: 'governance_version_activated',
          document: 'msp',
          urn: 'urn:graphheight:msp_version:1.0.1',
          version: '1.0.1',
          hash: 'abc123',
          activated_at: new Date().toISOString(),
          previous_version: '1.0.0-seed',
        },
      });

      assert.equal(result.status, 202);
      assert.equal(result.body.routing, 'broadcast');
    });

    test('PEM correlation_id preserved through pem_resolved closure', async () => {
      const sharedCorrelation = `urn:llm-ops:correlation:pem-closure-${Date.now()}`;

      // 1. PEM: Nomos → Senate
      await postMessage({
        type: 'PEM',
        source_organ: 'Nomos',
        target_organ: 'Senate',
        correlation_id: sharedCorrelation,
        reply_to: 'Nomos',
        payload: {
          conflict_class: 'MSP_CONFLICT',
          blocked_action: 'urn:test:ap', blocking_rules: ['MSP-X'],
          necessity: 'test', proposed_change: 'test', risk_assessment: 'low',
        },
      });

      // 2. pem_resolved: Senate → Nomos (same correlation_id)
      await postMessage({
        type: 'OTM',
        source_organ: 'Senate',
        target_organ: 'Nomos',
        correlation_id: sharedCorrelation,
        payload: {
          event_type: 'pem_resolved',
          per_ref: 'urn:test:pem',
          resolution: 'rejected',
          resolved_at: new Date().toISOString(),
        },
      });

      // 3. Verify both messages share correlation_id in audit
      const allPem = await queryEvents('PEM');
      const allOtm = await queryEvents('OTM');

      const pemEvent = allPem.events.find(e => e.envelope?.correlation_id === sharedCorrelation);
      const resolvedEvent = allOtm.events.find(e =>
        e.envelope?.correlation_id === sharedCorrelation &&
        e.envelope?.payload?.event_type === 'pem_resolved'
      );

      assert.ok(pemEvent, 'PEM must have shared correlation_id');
      assert.ok(resolvedEvent, 'pem_resolved must have shared correlation_id');
      assert.equal(pemEvent.envelope.correlation_id, resolvedEvent.envelope.correlation_id);
    });
  });

  // ─── Test Case B: BOR_CONFLICT + HOM ───

  describe('Test Case B: BOR_CONFLICT with HOM', () => {

    test('BOR_CONFLICT PEM routes to Senate', async () => {
      const correlationId = `urn:llm-ops:correlation:pem-bor-${Date.now()}`;
      const result = await postMessage({
        type: 'PEM',
        source_organ: 'Nomos',
        target_organ: 'Senate',
        correlation_id: correlationId,
        reply_to: 'Nomos',
        payload: {
          conflict_class: 'BOR_CONFLICT',
          blocked_action: 'urn:llm-ops:apm:test-bor-blocked',
          blocking_rules: ['BoR-Arbiter: AMBIGUOUS'],
          necessity: 'Action scope ambiguous under current BoR',
          proposed_change: 'Clarify BoR Article II scope',
          risk_assessment: 'Medium',
        },
      });

      assert.equal(result.status, 202);
      assert.equal(result.body.routing, 'directed');
    });

    test('Senate delivers BoR amendment to Arbiter via OTM (not PEM)', async () => {
      // Per architectural conclusions: Senate → Arbiter for BOR_CONFLICT
      // is OTM (artifact delivery), NOT part of PEM flow
      const result = await postMessage({
        type: 'OTM',
        source_organ: 'Senate',
        target_organ: 'Arbiter',
        payload: {
          event_type: 'bor_amendment_proposal',
          draft_id: 'urn:graphheight:amendment_draft:test-bor',
          per_ref: 'urn:llm-ops:pem:test-bor',
          proposed_language: 'Amended Article II clause...',
          rationale: 'Ambiguity in scope determination',
          impact_analysis: 'Clarifies scope for class of actions',
          affected_clauses: ['II.1'],
        },
      });

      assert.equal(result.status, 202);
      assert.equal(result.body.routing, 'directed');

      // Verify it's OTM, not PEM
      const events = await queryEvents('OTM');
      const proposal = events.events.find(e =>
        e.envelope?.payload?.event_type === 'bor_amendment_proposal'
      );
      assert.ok(proposal, 'bor_amendment_proposal must be OTM');
      assert.equal(proposal.message_type, 'OTM', 'must be OTM, not PEM');
    });

    test('HOM routes from Arbiter to Human_Principal (directed)', async () => {
      const correlationId = `urn:llm-ops:correlation:hom-bor-${Date.now()}`;
      const result = await postMessage({
        type: 'HOM',
        source_organ: 'Arbiter',
        target_organ: 'Human_Principal',
        correlation_id: correlationId,
        reply_to: 'Arbiter',
        payload: {
          decision_type: 'bor_ambiguity',
          context: 'Action scope ambiguous under Article II',
          question: 'Should the BoR be amended to clarify scope for graph write operations?',
          options: ['approve_amendment', 'reject_amendment', 'defer'],
          deadline: null,
        },
      });

      assert.equal(result.status, 202, 'Spine must accept directed HOM');
      assert.equal(result.body.routing, 'directed');

      // Verify HOM in audit trail
      const events = await queryEvents('HOM');
      assert.ok(events.count >= 1, 'HOM must appear in Spine audit trail');
      const hom = events.events.find(e => e.envelope?.correlation_id === correlationId);
      assert.ok(hom, 'HOM must exist with our correlation_id');
      assert.equal(hom.source_organ, 'Arbiter');
      assert.equal(hom.target_organ, 'Human_Principal');

      // Verify in Human_Principal mailbox
      const drained = await drainMailbox('Human_Principal');
      const homMsg = drained.messages.find(m => m.correlation_id === correlationId);
      assert.ok(homMsg, 'HOM must be in Human_Principal mailbox');
      assert.equal(homMsg.payload.decision_type, 'bor_ambiguity');
    });

    test('Human HOM response routes back to Arbiter', async () => {
      const correlationId = `urn:llm-ops:correlation:hom-response-${Date.now()}`;
      const result = await postMessage({
        type: 'HOM',
        source_organ: 'Human_Principal',
        target_organ: 'Arbiter',
        correlation_id: correlationId,
        reply_to: 'Human_Principal',
        payload: {
          decision_type: 'bor_ambiguity',
          context: 'Response to BoR amendment proposal',
          question: 'Amendment approved',
          options: ['approve_amendment'],
        },
      });

      assert.equal(result.status, 202);
      assert.equal(result.body.routing, 'directed');

      const drained = await drainMailbox('Arbiter');
      const response = drained.messages.find(m => m.correlation_id === correlationId);
      assert.ok(response, 'HOM response must reach Arbiter mailbox');
    });

    test('BOR_CONFLICT exercises all 5 message types', async () => {
      const sharedCorrelation = `urn:llm-ops:correlation:all-5-types-${Date.now()}`;

      // 1. OTM: Receptor → Thalamus (initial request)
      await postMessage({
        type: 'OTM', source_organ: 'Receptor', target_organ: 'Thalamus',
        correlation_id: sharedCorrelation,
        payload: { event_type: 'ingress_request', message: 'test' },
      });

      // 2. APM: Thalamus → Nomos (AP submitted)
      await postMessage({
        type: 'APM', source_organ: 'Thalamus', target_organ: 'Nomos',
        correlation_id: sharedCorrelation,
        payload: {
          action: 'test', targets: ['urn:test'], risk_tier: 'low',
          evidence_refs: [], rollback_plan: 'n/a', reason: 'test',
        },
      });

      // 3. PEM: Nomos → Senate (BOR_CONFLICT escalation)
      await postMessage({
        type: 'PEM', source_organ: 'Nomos', target_organ: 'Senate',
        correlation_id: sharedCorrelation,
        payload: {
          conflict_class: 'BOR_CONFLICT', blocked_action: 'urn:test:ap',
          blocking_rules: ['BoR-AMBIGUOUS'], necessity: 'test',
          proposed_change: 'clarify', risk_assessment: 'low',
        },
      });

      // 4. HOM: Arbiter → Human (BoR decision needed)
      await postMessage({
        type: 'HOM', source_organ: 'Arbiter', target_organ: 'Human_Principal',
        correlation_id: sharedCorrelation,
        payload: {
          decision_type: 'bor_ambiguity', context: 'test',
          question: 'approve?', options: ['yes', 'no'],
        },
      });

      // 5. ATM: Nomos → Thalamus (after BoR resolved, AP re-adjudicated)
      await postMessage({
        type: 'ATM', source_organ: 'Nomos', target_organ: 'Thalamus',
        correlation_id: sharedCorrelation,
        payload: {
          token_urn: `urn:llm-ops:token:all5-${Date.now()}`,
          scope: { targets: ['urn:test'], action_types: ['graph_concept_upsert'], ttl_seconds: 3600 },
          ap_ref: 'urn:test:ap',
        },
      });

      // Verify all 5 types present in audit with shared correlation_id
      const types = new Set();
      for (const type of ['OTM', 'APM', 'PEM', 'ATM', 'HOM']) {
        const events = await queryEvents(type);
        const matching = events.events.filter(e => e.envelope?.correlation_id === sharedCorrelation);
        if (matching.length > 0) types.add(type);
      }

      assert.equal(types.size, 5, `All 5 message types must be present. Got: ${[...types].join(', ')}`);
      assert.ok(types.has('OTM'), 'OTM present');
      assert.ok(types.has('APM'), 'APM present');
      assert.ok(types.has('PEM'), 'PEM present');
      assert.ok(types.has('ATM'), 'ATM present');
      assert.ok(types.has('HOM'), 'HOM present');
    });
  });

  // ─── Cross-cutting verification ───

  describe('Cross-cutting governance constraints', () => {

    test('PEM cannot broadcast', async () => {
      const result = await postMessage({
        type: 'PEM', source_organ: 'Nomos', target_organ: '*',
        payload: {
          conflict_class: 'MSP_CONFLICT', blocked_action: 'test',
          blocking_rules: [], necessity: 'test', proposed_change: 'test',
          risk_assessment: 'low',
        },
      });
      assert.equal(result.status, 400, 'PEM broadcast must be rejected');
    });

    test('HOM cannot broadcast', async () => {
      const result = await postMessage({
        type: 'HOM', source_organ: 'Arbiter', target_organ: '*',
        payload: {
          decision_type: 'bor_ambiguity', context: 'test',
          question: 'test?', options: ['yes'],
        },
      });
      assert.equal(result.status, 400, 'HOM broadcast must be rejected');
    });

    test('Spine preserves message_id uniqueness across all types', async () => {
      const ids = new Set();
      const types = ['OTM', 'APM', 'PEM', 'ATM', 'HOM'];
      const targets = ['*', 'Nomos', 'Senate', 'Thalamus', 'Arbiter'];

      for (let i = 0; i < types.length; i++) {
        const target = types[i] === 'OTM' ? '*' : targets[i];
        const payload = types[i] === 'OTM'
          ? { event_type: 'test_uniqueness' }
          : types[i] === 'APM'
            ? { action: 't', targets: [], risk_tier: 'low', evidence_refs: [], rollback_plan: 'n', reason: 't' }
            : types[i] === 'PEM'
              ? { conflict_class: 'MSP_CONFLICT', blocked_action: 't', blocking_rules: [], necessity: 't', proposed_change: 't', risk_assessment: 'l' }
              : types[i] === 'ATM'
                ? { token_urn: 'urn:t', scope: { targets: [], action_types: [], ttl_seconds: 60 }, ap_ref: 'urn:t' }
                : { decision_type: 'bor_ambiguity', context: 't', question: 't?', options: ['y'] };

        const result = await postMessage({
          type: types[i], source_organ: 'Thalamus', target_organ: target, payload,
        });
        if (result.status === 202) {
          assert.ok(!ids.has(result.body.message_id), `message_id unique for ${types[i]}`);
          ids.add(result.body.message_id);
        }
      }
    });
  });
});
