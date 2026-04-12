import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGraphContext } from '../lib/graph-context.js';

function fakeAdapter({ traverse = () => ({ entities: [], bindings: [], degraded: [] }), throwOn = null } = {}) {
  return {
    traverseFrom: async (urn, opts) => {
      if (throwOn === urn) throw new Error('fake-fail');
      return traverse(urn, opts);
    },
  };
}

test('returns no-seeds degraded when jobRecord has no URNs', async () => {
  const ctx = createGraphContext({ graphAdapter: fakeAdapter() });
  const result = await ctx.enrich({ jobRecord: { evidence_refs: [], intake_context: {} } });
  assert.equal(result.entities.length, 0);
  assert.ok(result.degraded.includes('graph-no-seeds'));
});

test('happy path with multiple seeds', async () => {
  const adapter = fakeAdapter({
    traverse: (urn) => ({
      entities: [{ urn, data: { type: 'test' } }],
      bindings: [{ urn: `b-${urn}` }],
      degraded: [],
    }),
  });
  const ctx = createGraphContext({ graphAdapter: adapter });
  const result = await ctx.enrich({
    jobRecord: {
      evidence_refs: ['urn:llm-ops:r:1', 'urn:llm-ops:r:2'],
      intake_context: { kind: 'cortex_goal', gap_ref: 'urn:llm-ops:g:1' },
    },
  });
  assert.equal(result.entities.length, 3);
  assert.equal(result.bindings.length, 3);
  assert.equal(result.degraded.length, 0);
});

test('partial failure: one seed throws, others succeed', async () => {
  const adapter = fakeAdapter({
    traverse: (urn) => ({ entities: [{ urn }], bindings: [], degraded: [] }),
    throwOn: 'urn:llm-ops:r:2',
  });
  const ctx = createGraphContext({ graphAdapter: adapter });
  const result = await ctx.enrich({
    jobRecord: { evidence_refs: ['urn:llm-ops:r:1', 'urn:llm-ops:r:2', 'urn:llm-ops:r:3'], intake_context: {} },
  });
  assert.equal(result.entities.length, 2);
  assert.ok(result.degraded.some(d => d.startsWith('graph-seed-failed')));
});

test('all seeds failed -> graphheight-read-failed flag', async () => {
  const adapter = {
    traverseFrom: async () => { throw new Error('all-down'); },
  };
  const ctx = createGraphContext({ graphAdapter: adapter });
  const result = await ctx.enrich({
    jobRecord: { evidence_refs: ['urn:llm-ops:r:1'], intake_context: {} },
  });
  assert.ok(result.degraded.includes('graphheight-read-failed'));
});

test('entities are capped at 50', async () => {
  const adapter = {
    traverseFrom: async () => ({
      entities: Array.from({ length: 60 }, (_, i) => ({ urn: `urn:test:${i}` })),
      bindings: [],
      degraded: [],
    }),
  };
  const ctx = createGraphContext({ graphAdapter: adapter });
  const result = await ctx.enrich({
    jobRecord: { evidence_refs: ['urn:llm-ops:r:1'], intake_context: {} },
  });
  assert.ok(result.entities.length <= 50);
});

test('seeds are deduplicated even when both urns and jobRecord seeds overlap', async () => {
  let calls = 0;
  const adapter = {
    traverseFrom: async (urn) => { calls++; return { entities: [{ urn }], bindings: [], degraded: [] }; },
  };
  const ctx = createGraphContext({ graphAdapter: adapter });
  await ctx.enrich({
    urns: ['urn:llm-ops:r:1'],
    jobRecord: {
      evidence_refs: ['urn:llm-ops:r:1'],
      intake_context: { kind: 'cortex_goal', gap_ref: 'urn:llm-ops:r:1' },
    },
  });
  assert.equal(calls, 1, 'duplicate URN must only be traversed once');
});

test('returns seeds_used in result', async () => {
  const adapter = fakeAdapter({
    traverse: (urn) => ({ entities: [{ urn }], bindings: [], degraded: [] }),
  });
  const ctx = createGraphContext({ graphAdapter: adapter });
  const result = await ctx.enrich({
    jobRecord: { evidence_refs: ['urn:llm-ops:r:1'], intake_context: {} },
  });
  assert.deepEqual(result.seeds_used, ['urn:llm-ops:r:1']);
});
