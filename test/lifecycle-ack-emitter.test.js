import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLifecycleAckEmitter } from '../lib/lifecycle-ack-emitter.js';

function makeFakeSpine() {
  const sent = [];
  return { sent, send: async (env) => { sent.push(env); return { message_id: 'urn:test:1' }; } };
}

const baseJob = {
  job_urn: 'urn:llm-ops:job:test-1',
  reply_to: 'Cortex',
  originator_ref: 'urn:llm-ops:otm:src-1',
  state: 'CREATED',
  lane: 'pending',
};

test('emit job_record_created sends OTM to reply_to with correct payload', async () => {
  const spine = makeFakeSpine();
  const e = createLifecycleAckEmitter({ spine });
  const result = await e.emit('job_record_created', { jobRecord: baseJob });
  assert.equal(result.dispatched, true);
  assert.equal(spine.sent.length, 1);
  const env = spine.sent[0];
  assert.equal(env.target_organ, 'Cortex');
  assert.equal(env.payload.event_type, 'job_record_created');
  assert.equal(env.payload.job_id, 'urn:llm-ops:job:test-1');
  assert.equal(env.payload.originator_ref, 'urn:llm-ops:otm:src-1');
  assert.equal(env.message_id, undefined, 'Spine assigns message_id server-side');
  assert.equal(env.timestamp, undefined, 'Spine assigns timestamp server-side');
});

test('all 4 lifecycle event types are valid', async () => {
  const spine = makeFakeSpine();
  const e = createLifecycleAckEmitter({ spine });
  for (const evt of ['job_record_created', 'job_dispatched', 'job_completed', 'job_failed']) {
    const result = await e.emit(evt, { jobRecord: baseJob });
    assert.equal(result.dispatched, true, `${evt} must be valid`);
  }
});

test('invalid event_type is rejected', async () => {
  const spine = makeFakeSpine();
  const e = createLifecycleAckEmitter({ spine });
  const result = await e.emit('something_else', { jobRecord: baseJob });
  assert.equal(result.dispatched, false);
  assert.equal(result.reason, 'invalid_event_type');
  assert.equal(spine.sent.length, 0);
});

test('skipped when reply_to is missing', async () => {
  const spine = makeFakeSpine();
  const e = createLifecycleAckEmitter({ spine });
  const result = await e.emit('job_record_created', { jobRecord: { ...baseJob, reply_to: null } });
  assert.equal(result.dispatched, false);
  assert.equal(result.reason, 'no_reply_to');
});

test('spine.send failure returns dispatched: false but does not throw', async () => {
  const failingSpine = { send: async () => { throw new Error('boom'); } };
  const e = createLifecycleAckEmitter({ spine: failingSpine });
  const result = await e.emit('job_record_created', { jobRecord: baseJob });
  assert.equal(result.dispatched, false);
  assert.equal(result.reason, 'spine_send_failed');
});

test('extra fields are merged into the payload', async () => {
  const spine = makeFakeSpine();
  const e = createLifecycleAckEmitter({ spine });
  await e.emit('job_dispatched', { jobRecord: baseJob, extra: { token_urn: 'urn:t:1', target_organs: ['Cerberus'] } });
  const env = spine.sent[0];
  assert.equal(env.payload.token_urn, 'urn:t:1');
  assert.deepEqual(env.payload.target_organs, ['Cerberus']);
});
