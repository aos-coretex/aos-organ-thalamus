import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createJobStore } from '../lib/job-store.js';

function makeJob(urn, overrides = {}) {
  return {
    job_urn: urn,
    source: 'cortex',
    originator_ref: 'ref-1',
    reply_to: 'Cortex',
    priority: 'medium',
    description: 'test job',
    state: 'CREATED',
    lane: 'pending',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

test('add stores a job and size reflects it', () => {
  const store = createJobStore();
  store.add(makeJob('urn:llm-ops:job:a'));
  assert.equal(store.size(), 1);
  assert.ok(store.get('urn:llm-ops:job:a'));
});

test('add rejects duplicate URN', () => {
  const store = createJobStore();
  store.add(makeJob('urn:llm-ops:job:a'));
  assert.throws(
    () => store.add(makeJob('urn:llm-ops:job:a')),
    /job_already_exists/,
  );
});

test('add rejects missing URN', () => {
  const store = createJobStore();
  assert.throws(
    () => store.add({ source: 'cortex' }),
    /job_record_missing_urn/,
  );
});

test('update patches fields and bumps updated_at', () => {
  const store = createJobStore();
  const job = makeJob('urn:llm-ops:job:a');
  store.add(job);
  const before = job.updated_at;

  // Ensure a tiny delay for timestamp comparison
  const updated = store.update('urn:llm-ops:job:a', { state: 'PLANNING' });
  assert.equal(updated.state, 'PLANNING');
  assert.equal(updated.source, 'cortex'); // unchanged field preserved
  assert.ok(updated.updated_at >= before);
});

test('update throws for unknown URN', () => {
  const store = createJobStore();
  assert.throws(
    () => store.update('urn:llm-ops:job:nonexistent', { state: 'PLANNING' }),
    /job_not_found/,
  );
});

test('get returns null for unknown URN', () => {
  const store = createJobStore();
  assert.equal(store.get('urn:llm-ops:job:unknown'), null);
});

test('list filters by status', () => {
  const store = createJobStore();
  store.add(makeJob('urn:llm-ops:job:a', { state: 'CREATED' }));
  store.add(makeJob('urn:llm-ops:job:b', { state: 'PLANNING' }));
  store.add(makeJob('urn:llm-ops:job:c', { state: 'CREATED' }));

  const created = store.list({ status: 'CREATED' });
  assert.equal(created.length, 2);
  assert.ok(created.every(j => j.state === 'CREATED'));
});

test('list filters by source', () => {
  const store = createJobStore();
  store.add(makeJob('urn:llm-ops:job:a', { source: 'cortex' }));
  store.add(makeJob('urn:llm-ops:job:b', { source: 'receptor' }));

  const cortex = store.list({ source: 'cortex' });
  assert.equal(cortex.length, 1);
  assert.equal(cortex[0].source, 'cortex');
});

test('list respects limit parameter', () => {
  const store = createJobStore();
  for (let i = 0; i < 10; i++) {
    store.add(makeJob(`urn:llm-ops:job:${i}`));
  }
  const limited = store.list({ limit: 3 });
  assert.equal(limited.length, 3);
});

test('FIFO eviction only removes terminal-state jobs', () => {
  const store = createJobStore({ limit: 3 });
  store.add(makeJob('urn:llm-ops:job:a', { state: 'SUCCEEDED' }));
  store.add(makeJob('urn:llm-ops:job:b', { state: 'PLANNING' }));
  store.add(makeJob('urn:llm-ops:job:c', { state: 'SUCCEEDED' }));

  // Adding a 4th should evict the oldest terminal (job:a)
  store.add(makeJob('urn:llm-ops:job:d'));
  assert.equal(store.get('urn:llm-ops:job:a'), null, 'oldest terminal job should be evicted');
  assert.ok(store.get('urn:llm-ops:job:b'), 'non-terminal job should be protected');
  assert.equal(store.size(), 3);
});

test('FIFO eviction does not remove non-terminal jobs even when over limit', () => {
  const store = createJobStore({ limit: 2 });
  store.add(makeJob('urn:llm-ops:job:a', { state: 'PLANNING' }));
  store.add(makeJob('urn:llm-ops:job:b', { state: 'EXECUTING' }));

  // Adding a 3rd — neither existing job is terminal, so no eviction happens
  store.add(makeJob('urn:llm-ops:job:c'));
  assert.equal(store.size(), 3, 'non-terminal jobs cannot be evicted');
});

test('stats returns correct counts by state', () => {
  const store = createJobStore();
  store.add(makeJob('urn:llm-ops:job:a', { state: 'CREATED' }));
  store.add(makeJob('urn:llm-ops:job:b', { state: 'PLANNING' }));
  store.add(makeJob('urn:llm-ops:job:c', { state: 'SUCCEEDED' }));
  store.add(makeJob('urn:llm-ops:job:d', { state: 'SUCCEEDED' }));

  const s = store.stats();
  assert.equal(s.total, 4);
  assert.equal(s.by_state.CREATED, 1);
  assert.equal(s.by_state.PLANNING, 1);
  assert.equal(s.by_state.SUCCEEDED, 2);
  assert.equal(s.by_state.FAILED, 0);
});

test('clear empties the store', () => {
  const store = createJobStore();
  store.add(makeJob('urn:llm-ops:job:a'));
  store.add(makeJob('urn:llm-ops:job:b'));
  assert.equal(store.size(), 2);
  store.clear();
  assert.equal(store.size(), 0);
  assert.equal(store.get('urn:llm-ops:job:a'), null);
});
