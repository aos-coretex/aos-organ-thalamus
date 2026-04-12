import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMissionLoader } from '../lib/mission-loader.js';

function fakeGraph({ msp, throwOnQuery = false } = {}) {
  return {
    queryConcepts: async () => {
      if (throwOnQuery) throw new Error('graph unreachable');
      if (msp === null) return { rows: [], count: 0 };
      return { rows: [msp], count: 1 };
    },
    getConcept: async () => null,
  };
}

function fakeArbiter({ bor, throwOnFetch = false } = {}) {
  return {
    getBoRRaw: async () => {
      if (throwOnFetch) throw new Error('arbiter unreachable');
      return bor;
    },
  };
}

const sampleMspRow = {
  urn: 'urn:graphheight:msp_version:1.0.0-seed',
  created_at: '2026-04-11T00:00:00Z',
  data: {
    type: 'msp_version',
    version: '1.0.0-seed',
    status: 'active',
    hash: 'abcdef123',
    raw_text: '# Mission Statement Protocol\n\n## Purpose\n\nThe MSP is the operational constitution.',
    activated_at: '2026-04-10T00:00:00Z',
  },
};

const sampleBor = {
  version: '1.0.0',
  hash: '987fedcba',
  raw_text: '# Bill of Rights\n\n## Article 1: Agency',
  effective_since: '2026-04-01T00:00:00Z',
  loaded_at: '2026-04-11T00:00:00Z',
};

test('loadMission composes both MSP and BoR on happy path', async () => {
  const loader = createMissionLoader({
    graphAdapter: fakeGraph({ msp: sampleMspRow }),
    arbiterClient: fakeArbiter({ bor: sampleBor }),
  });
  const frame = await loader.loadMission();
  assert.equal(frame.msp.version, '1.0.0-seed');
  assert.ok(frame.msp.raw_text.startsWith('# Mission'));
  assert.equal(frame.bor.version, '1.0.0');
  assert.ok(frame.bor.raw_text.startsWith('# Bill of Rights'));
  assert.deepEqual(frame.degraded, []);
});

test('loadMission flags msp-missing-from-graph when no active msp_version', async () => {
  const loader = createMissionLoader({
    graphAdapter: fakeGraph({ msp: null }),
    arbiterClient: fakeArbiter({ bor: sampleBor }),
  });
  const frame = await loader.loadMission();
  assert.equal(frame.msp, null);
  assert.equal(frame.bor.version, '1.0.0');
  assert.ok(frame.degraded.includes('msp-missing-from-graph'));
});

test('loadMission flags graph-unreachable on query error', async () => {
  const loader = createMissionLoader({
    graphAdapter: fakeGraph({ throwOnQuery: true }),
    arbiterClient: fakeArbiter({ bor: sampleBor }),
  });
  const frame = await loader.loadMission();
  assert.equal(frame.msp, null);
  assert.ok(frame.degraded.includes('graph-unreachable'));
});

test('loadMission flags bor-unavailable when Arbiter returns null', async () => {
  const loader = createMissionLoader({
    graphAdapter: fakeGraph({ msp: sampleMspRow }),
    arbiterClient: fakeArbiter({ bor: null }),
  });
  const frame = await loader.loadMission();
  assert.equal(frame.msp.version, '1.0.0-seed');
  assert.equal(frame.bor, null);
  assert.ok(frame.degraded.includes('bor-unavailable'));
});

test('loadMission flags arbiter-unreachable on fetch error', async () => {
  const loader = createMissionLoader({
    graphAdapter: fakeGraph({ msp: sampleMspRow }),
    arbiterClient: fakeArbiter({ throwOnFetch: true }),
  });
  const frame = await loader.loadMission();
  assert.equal(frame.bor, null);
  assert.ok(frame.degraded.includes('arbiter-unreachable'));
});

test('loadMission handles both sources missing (fully degraded frame)', async () => {
  const loader = createMissionLoader({
    graphAdapter: fakeGraph({ throwOnQuery: true }),
    arbiterClient: fakeArbiter({ throwOnFetch: true }),
  });
  const frame = await loader.loadMission();
  assert.equal(frame.msp, null);
  assert.equal(frame.bor, null);
  assert.equal(frame.degraded.length, 2);
});

test('loadMission legacy-compat: msp_version concept without raw_text', async () => {
  const legacy = { ...sampleMspRow, data: { ...sampleMspRow.data, raw_text: undefined } };
  const loader = createMissionLoader({
    graphAdapter: fakeGraph({ msp: legacy }),
    arbiterClient: fakeArbiter({ bor: sampleBor }),
  });
  const frame = await loader.loadMission();
  assert.equal(frame.msp.raw_text, '');
  assert.equal(frame.msp.version, '1.0.0-seed');
  assert.ok(frame.degraded.includes('msp-raw-text-absent'));
});

test('loadMission serves from cache within TTL', async () => {
  let callCount = 0;
  const graph = {
    queryConcepts: async () => { callCount += 1; return { rows: [sampleMspRow], count: 1 }; },
  };
  const loader = createMissionLoader({
    graphAdapter: graph,
    arbiterClient: fakeArbiter({ bor: sampleBor }),
    cacheTtlMs: 60000,
  });
  await loader.loadMission();
  await loader.loadMission();
  await loader.loadMission();
  assert.equal(callCount, 1, 'cached result should short-circuit subsequent calls');
});

test('loadMission re-fetches after invalidate()', async () => {
  let callCount = 0;
  const graph = {
    queryConcepts: async () => { callCount += 1; return { rows: [sampleMspRow], count: 1 }; },
  };
  const loader = createMissionLoader({
    graphAdapter: graph,
    arbiterClient: fakeArbiter({ bor: sampleBor }),
    cacheTtlMs: 60000,
  });
  await loader.loadMission();
  loader.invalidate('msp_updated');
  await loader.loadMission();
  assert.equal(callCount, 2);
});

test('peekCache returns null after invalidate', async () => {
  const loader = createMissionLoader({
    graphAdapter: fakeGraph({ msp: sampleMspRow }),
    arbiterClient: fakeArbiter({ bor: sampleBor }),
    cacheTtlMs: 60000,
  });
  await loader.loadMission();
  assert.notEqual(loader.peekCache(), null);
  loader.invalidate('test');
  assert.equal(loader.peekCache(), null);
});
