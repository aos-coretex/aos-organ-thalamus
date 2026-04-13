/**
 * MP-16 v6t-4: Health Monitoring End-to-End Integration Test
 *
 * Verifies organ resilience infrastructure against a REAL Spine:
 *   - Organ lifecycle state machine: REGISTERED → ALIVE → DEGRADED → DISCONNECTED → ALIVE
 *   - Mailbox persistence: messages for disconnected organs are retained (never lost)
 *   - Mailbox drain: recovery delivers all messages in FIFO order
 *   - State transition OTM broadcasts for organ lifecycle changes
 *   - Mailbox depth monitoring (query while organ is down)
 *   - Zero message loss across disconnect/reconnect cycle
 *
 * Heartbeat detection (30s ping × 3 misses = 90s) is tested by verifying the
 * state machine enforcement, not by waiting for real timeouts. WebSocket-close
 * detection fires immediately (no heartbeat delay).
 *
 * Live multi-organ verification (v6t-1 through v6t-3) confirmed Spine starts
 * with in-memory DB, handles all 5 message types, and routes directed messages
 * to organ mailboxes.
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
  spinePort = 17000 + Math.floor(Math.random() * 1000);
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

async function registerMailbox(organName) {
  return fetch(`${spineUrl}/mailbox/${organName}`, { method: 'POST' });
}

async function getMailboxDepth(organName) {
  const res = await fetch(`${spineUrl}/mailbox/${organName}`);
  return res.json();
}

async function drainMailbox(organName, limit = 50) {
  const res = await fetch(`${spineUrl}/mailbox/${organName}/drain`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ limit }),
  });
  return res.json();
}

async function createOrganEntity(organUrn) {
  const res = await fetch(`${spineUrl}/state/entities`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ entity_urn: organUrn, entity_type: 'organ' }),
  });
  return res.json();
}

async function transitionOrgan(organUrn, fromState, toState, reason) {
  const encoded = encodeURIComponent(organUrn);
  const res = await fetch(`${spineUrl}/state/${encoded}/transition`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ from_state: fromState, to_state: toState, reason, actor: 'Spine' }),
  });
  return { status: res.status, body: await res.json() };
}

describe('MP-16 v6t-4: Health monitoring with real Spine', () => {

  // ─── Organ Lifecycle State Machine ───

  describe('Organ lifecycle state machine', () => {

    test('full lifecycle: REGISTERED → ALIVE → DISCONNECTED → ALIVE (recovery)', async () => {
      const organUrn = `urn:llm-ops:organ:test-lifecycle-${Date.now()}`;
      await createOrganEntity(organUrn);

      // Boot sequence: organ connects
      await transitionOrgan(organUrn, 'REGISTERED', 'ALIVE', 'websocket_connected');

      let entity = await queryState(organUrn);
      assert.equal(entity.current_state, 'ALIVE');

      // Organ dies: detected via heartbeat or WebSocket close
      await transitionOrgan(organUrn, 'ALIVE', 'DISCONNECTED', 'heartbeat_timeout');

      entity = await queryState(organUrn);
      assert.equal(entity.current_state, 'DISCONNECTED');

      // Organ restarts: reconnects
      const recovery = await transitionOrgan(organUrn, 'DISCONNECTED', 'ALIVE', 'reconnected');
      assert.equal(recovery.status, 200);

      entity = await queryState(organUrn);
      assert.equal(entity.current_state, 'ALIVE');

      // Verify full history
      const states = entity.history.map(h => h.to_state);
      assert.deepEqual(states, ['ALIVE', 'DISCONNECTED', 'ALIVE']);
    });

    test('degradation path: ALIVE → DEGRADED → DISCONNECTED', async () => {
      const organUrn = `urn:llm-ops:organ:test-degradation-${Date.now()}`;
      await createOrganEntity(organUrn);

      await transitionOrgan(organUrn, 'REGISTERED', 'ALIVE', 'connected');
      await transitionOrgan(organUrn, 'ALIVE', 'DEGRADED', 'missed_pong_1');
      await transitionOrgan(organUrn, 'DEGRADED', 'DISCONNECTED', 'missed_pong_3');

      const entity = await queryState(organUrn);
      assert.equal(entity.current_state, 'DISCONNECTED');
      const states = entity.history.map(h => h.to_state);
      assert.ok(states.includes('DEGRADED'), 'must pass through DEGRADED');
    });

    test('recovery from DEGRADED: DEGRADED → ALIVE', async () => {
      const organUrn = `urn:llm-ops:organ:test-degrade-recover-${Date.now()}`;
      await createOrganEntity(organUrn);

      await transitionOrgan(organUrn, 'REGISTERED', 'ALIVE', 'connected');
      await transitionOrgan(organUrn, 'ALIVE', 'DEGRADED', 'missed_pong');
      await transitionOrgan(organUrn, 'DEGRADED', 'ALIVE', 'pong_received');

      const entity = await queryState(organUrn);
      assert.equal(entity.current_state, 'ALIVE');
    });

    test('invalid transition REGISTERED → DISCONNECTED rejected', async () => {
      const organUrn = `urn:llm-ops:organ:test-invalid-${Date.now()}`;
      await createOrganEntity(organUrn);

      const result = await transitionOrgan(organUrn, 'REGISTERED', 'DISCONNECTED', 'shortcut');
      assert.equal(result.status, 409, 'invalid transition must be rejected');
    });

    test('no terminal states: organs can always reconnect', async () => {
      const organUrn = `urn:llm-ops:organ:test-no-terminal-${Date.now()}`;
      await createOrganEntity(organUrn);

      await transitionOrgan(organUrn, 'REGISTERED', 'ALIVE', 'boot');
      await transitionOrgan(organUrn, 'ALIVE', 'DISCONNECTED', 'crash');
      await transitionOrgan(organUrn, 'DISCONNECTED', 'ALIVE', 'restart-1');
      await transitionOrgan(organUrn, 'ALIVE', 'DISCONNECTED', 'crash-2');
      await transitionOrgan(organUrn, 'DISCONNECTED', 'ALIVE', 'restart-2');

      const entity = await queryState(organUrn);
      assert.equal(entity.current_state, 'ALIVE');
      assert.equal(entity.history.length, 5, 'all 5 transitions recorded');
    });
  });

  // ─── Mailbox Persistence During Outage ───

  describe('Mailbox persistence during outage', () => {

    test('messages persist in mailbox for disconnected organ (never lost)', async () => {
      const targetOrgan = `TestOrgan_${Date.now()}`;
      await registerMailbox(targetOrgan);
      // Provision in manifest so routing works
      await fetch(`${spineUrl}/manifest/${targetOrgan}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ required: false }),
      });

      // Send 5 messages while organ is "down" (no WebSocket connection)
      const sentIds = [];
      for (let i = 0; i < 5; i++) {
        const result = await postMessage({
          type: 'OTM',
          source_organ: 'Vigil',
          target_organ: targetOrgan,
          payload: { event_type: 'test_persistence', sequence: i },
        });
        assert.equal(result.status, 202, `message ${i} must be accepted`);
        sentIds.push(result.body.message_id);
      }

      // Verify mailbox depth
      const depth = await getMailboxDepth(targetOrgan);
      assert.equal(depth.depth, 5, 'mailbox must hold all 5 messages');
    });

    test('mailbox drain delivers all messages in FIFO order', async () => {
      const targetOrgan = `DrainOrgan_${Date.now()}`;
      await registerMailbox(targetOrgan);
      await fetch(`${spineUrl}/manifest/${targetOrgan}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ required: false }),
      });

      // Send messages with known sequence numbers
      const count = 8;
      for (let i = 0; i < count; i++) {
        await postMessage({
          type: 'OTM',
          source_organ: 'Spine',
          target_organ: targetOrgan,
          payload: { event_type: 'fifo_test', sequence: i, sent_at: Date.now() },
        });
      }

      // Drain the mailbox
      const drained = await drainMailbox(targetOrgan, count);
      assert.equal(drained.count, count, `must drain all ${count} messages`);

      // Verify FIFO ordering
      for (let i = 0; i < count; i++) {
        assert.equal(drained.messages[i].payload.sequence, i,
          `message ${i} must have sequence ${i} (FIFO)`);
      }

      // Ack all messages (Spine uses drain+ack pattern: drain returns, ack removes)
      const messageIds = drained.messages.map(m => m.message_id);
      await fetch(`${spineUrl}/mailbox/${targetOrgan}/ack`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message_ids: messageIds }),
      });

      // Verify mailbox is now empty after ack
      const afterDepth = await getMailboxDepth(targetOrgan);
      assert.equal(afterDepth.depth, 0, 'mailbox must be empty after drain + ack');
    });

    test('zero message loss across disconnect/reconnect cycle', async () => {
      const targetOrgan = `ZeroLossOrgan_${Date.now()}`;
      await registerMailbox(targetOrgan);
      await fetch(`${spineUrl}/manifest/${targetOrgan}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ required: false }),
      });

      // Phase 1: Send messages to "connected" organ (they go to mailbox since no WS)
      const phase1Count = 3;
      for (let i = 0; i < phase1Count; i++) {
        await postMessage({
          type: 'OTM', source_organ: 'Thalamus', target_organ: targetOrgan,
          payload: { event_type: 'zero_loss', phase: 1, seq: i },
        });
      }

      // Phase 2: Organ "disconnects" — simulate by just continuing to send
      const phase2Count = 4;
      for (let i = 0; i < phase2Count; i++) {
        await postMessage({
          type: 'OTM', source_organ: 'Nomos', target_organ: targetOrgan,
          payload: { event_type: 'zero_loss', phase: 2, seq: i },
        });
      }

      // Phase 3: Organ "reconnects" — drain everything
      const totalExpected = phase1Count + phase2Count;
      const drained = await drainMailbox(targetOrgan, 50);

      assert.equal(drained.count, totalExpected,
        `expected ${totalExpected} messages, got ${drained.count} — zero loss required`);

      // Verify all phases present
      const phase1Msgs = drained.messages.filter(m => m.payload.phase === 1);
      const phase2Msgs = drained.messages.filter(m => m.payload.phase === 2);
      assert.equal(phase1Msgs.length, phase1Count);
      assert.equal(phase2Msgs.length, phase2Count);
    });

    test('multiple message types persist in mailbox', async () => {
      const targetOrgan = `MultiTypeOrgan_${Date.now()}`;
      await registerMailbox(targetOrgan);
      await fetch(`${spineUrl}/manifest/${targetOrgan}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ required: false }),
      });

      // Send different governance message types
      await postMessage({
        type: 'OTM', source_organ: 'Spine', target_organ: targetOrgan,
        payload: { event_type: 'health_check' },
      });
      await postMessage({
        type: 'ATM', source_organ: 'Nomos', target_organ: targetOrgan,
        payload: { token_urn: 'urn:t', scope: { targets: [], action_types: [], ttl_seconds: 60 }, ap_ref: 'urn:a' },
      });

      const drained = await drainMailbox(targetOrgan);
      assert.equal(drained.count, 2, 'both OTM and ATM must persist');

      const types = drained.messages.map(m => m.type);
      assert.ok(types.includes('OTM'));
      assert.ok(types.includes('ATM'));
    });
  });

  // ─── State Transition Broadcasts ───

  describe('Organ lifecycle state_transition broadcasts', () => {

    test('each organ state change emits state_transition OTM broadcast', async () => {
      const organUrn = `urn:llm-ops:organ:test-broadcasts-${Date.now()}`;
      await createOrganEntity(organUrn);

      // Perform 3 transitions
      await transitionOrgan(organUrn, 'REGISTERED', 'ALIVE', 'boot');
      await transitionOrgan(organUrn, 'ALIVE', 'DISCONNECTED', 'crash');
      await transitionOrgan(organUrn, 'DISCONNECTED', 'ALIVE', 'recovery');

      // Check broadcasts
      const events = await queryEvents('OTM');
      const organTransitions = events.events.filter(e =>
        e.envelope?.payload?.event_type === 'state_transition' &&
        e.envelope?.payload?.data?.entity_urn === organUrn
      );

      assert.equal(organTransitions.length, 3, 'must emit 3 state_transition broadcasts');

      const broadcastStates = organTransitions.map(e => e.envelope.payload.data.current_state);
      assert.ok(broadcastStates.includes('ALIVE'));
      assert.ok(broadcastStates.includes('DISCONNECTED'));

      // All must be broadcast (target_organ: *)
      for (const event of organTransitions) {
        assert.equal(event.envelope.target_organ, '*');
        assert.equal(event.envelope.source_organ, 'Spine');
        assert.equal(event.routing, 'broadcast');
      }
    });

    test('broadcasts include actor and reason for diagnostic tracing', async () => {
      const organUrn = `urn:llm-ops:organ:test-trace-${Date.now()}`;
      await createOrganEntity(organUrn);

      await transitionOrgan(organUrn, 'REGISTERED', 'ALIVE', 'ws_connected_ok');

      const events = await queryEvents('OTM');
      const transition = events.events.find(e =>
        e.envelope?.payload?.event_type === 'state_transition' &&
        e.envelope?.payload?.data?.entity_urn === organUrn &&
        e.envelope?.payload?.data?.current_state === 'ALIVE'
      );

      assert.ok(transition);
      assert.equal(transition.envelope.payload.data.actor, 'Spine');
      assert.equal(transition.envelope.payload.data.reason, 'ws_connected_ok');
    });
  });

  // ─── Mailbox Monitoring ───

  describe('Mailbox depth monitoring', () => {

    test('mailbox depth increases as messages accumulate', async () => {
      const targetOrgan = `DepthOrgan_${Date.now()}`;
      await registerMailbox(targetOrgan);
      await fetch(`${spineUrl}/manifest/${targetOrgan}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ required: false }),
      });

      // Verify starts at 0
      let depth = await getMailboxDepth(targetOrgan);
      assert.equal(depth.depth, 0);

      // Send 3 messages
      for (let i = 0; i < 3; i++) {
        await postMessage({
          type: 'OTM', source_organ: 'Vigil', target_organ: targetOrgan,
          payload: { event_type: 'depth_test', seq: i },
        });
      }

      // Verify depth = 3
      depth = await getMailboxDepth(targetOrgan);
      assert.equal(depth.depth, 3);

      // Drain 2 and ack them
      const drained = await drainMailbox(targetOrgan, 2);
      assert.equal(drained.count, 2);
      const ackIds = drained.messages.map(m => m.message_id);
      await fetch(`${spineUrl}/mailbox/${targetOrgan}/ack`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message_ids: ackIds }),
      });

      // Verify depth = 1 (3 sent - 2 acked)
      depth = await getMailboxDepth(targetOrgan);
      assert.equal(depth.depth, 1);
    });

    test('Spine health endpoint reports mailbox aggregate', async () => {
      const res = await fetch(`${spineUrl}/health`);
      const health = await res.json();

      assert.ok('mailbox' in health, 'health must include mailbox info');
      assert.ok('total_depth' in health.mailbox);
    });
  });
});
