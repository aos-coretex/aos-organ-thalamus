/**
 * CV: Lane selection deterministic — verifies that createLaneSelector
 * produces the same output for the same input with no LLM in the path.
 *
 * Asserts:
 *   - same input always produces same output (deterministic)
 *   - write-target -> write lane
 *   - all-r0 -> r0 lane
 *   - unknown targets -> write (conservative fail-closed)
 *   - no LLM in the classification path
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLaneSelector } from '../lib/lane-selector.js';

const TEST_TABLE = {
  actions: {
    'Radiant:query': 'r0',
    'Radiant:promote': 'write',
    'Engram:read': 'r0',
    'Engram:ingest': 'write',
    'Graph:query': 'r0',
    'Graph:upsert': 'write',
    'SafeVault:backup': 'write',
  },
  intake_heuristic: {
    r0_keywords: ['report', 'show', 'query', 'read', 'get'],
    write_keywords: ['create', 'update', 'delete', 'ingest', 'write'],
  },
};

function makeJob({ targets = [], intake_context = null, description = '' }) {
  return {
    job_urn: 'urn:llm-ops:job:cv-lane',
    targets,
    intake_context,
    description,
  };
}

test('CV: deterministic — same input always produces same output', () => {
  const sel = createLaneSelector({ table: TEST_TABLE });
  const job = makeJob({ targets: ['Radiant:query', 'Engram:read'] });

  const results = [];
  for (let i = 0; i < 10; i++) {
    results.push(sel.selectLane(job));
  }

  // All 10 results must be identical
  for (const r of results) {
    assert.equal(r.lane, results[0].lane);
    assert.equal(r.reasoning, results[0].reasoning);
    assert.deepEqual(r.r0_targets, results[0].r0_targets);
    assert.deepEqual(r.write_targets, results[0].write_targets);
    assert.deepEqual(r.ambiguous_targets, results[0].ambiguous_targets);
  }
});

test('CV: write-target classifies to write lane', () => {
  const sel = createLaneSelector({ table: TEST_TABLE });
  const result = sel.selectLane(makeJob({ targets: ['Engram:ingest'] }));
  assert.equal(result.lane, 'write');
  assert.deepEqual(result.write_targets, ['Engram:ingest']);
  assert.equal(result.r0_targets.length, 0);

  // Mixed: any write target forces write lane
  const mixed = sel.selectLane(makeJob({ targets: ['Radiant:query', 'Graph:upsert'] }));
  assert.equal(mixed.lane, 'write');
  assert.deepEqual(mixed.write_targets, ['Graph:upsert']);
  assert.deepEqual(mixed.r0_targets, ['Radiant:query']);
});

test('CV: all-r0 targets classify to r0 lane', () => {
  const sel = createLaneSelector({ table: TEST_TABLE });
  const result = sel.selectLane(makeJob({ targets: ['Radiant:query', 'Engram:read', 'Graph:query'] }));
  assert.equal(result.lane, 'r0');
  assert.deepEqual(result.r0_targets, ['Radiant:query', 'Engram:read', 'Graph:query']);
  assert.equal(result.write_targets.length, 0);
  assert.equal(result.ambiguous_targets.length, 0);
});

test('CV: unknown targets default to write (conservative fail-closed)', () => {
  const sel = createLaneSelector({ table: TEST_TABLE });
  const result = sel.selectLane(makeJob({ targets: ['Unknown:mystery', 'Alien:op'] }));
  assert.equal(result.lane, 'write');
  assert.deepEqual(result.ambiguous_targets, ['Unknown:mystery', 'Alien:op']);
  assert.match(result.reasoning, /unknown-defaulted-to-write/);
});

test('CV: no LLM in the classification path — selectLane is synchronous', () => {
  const sel = createLaneSelector({ table: TEST_TABLE });

  // selectLane is a regular function, not async. If it returned a Promise,
  // that would indicate an LLM call somewhere in the path.
  const job = makeJob({ targets: ['Radiant:query'] });
  const result = sel.selectLane(job);

  // Verify it returns a plain object, not a Promise
  assert.equal(typeof result, 'object');
  assert.equal(typeof result.then, 'undefined', 'selectLane must not return a Promise — no LLM in the path');
  assert.equal(result.lane, 'r0');

  // Also verify classifyTarget is synchronous
  const ct = sel.classifyTarget('Radiant:query');
  assert.equal(typeof ct.then, 'undefined', 'classifyTarget must not return a Promise');
});
