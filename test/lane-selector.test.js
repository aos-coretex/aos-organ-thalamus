import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLaneSelector, loadClassifierTable } from '../lib/lane-selector.js';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const TEST_TABLE = {
  actions: {
    'Radiant:query': 'r0',
    'Radiant:promote': 'write',
    'Engram:read': 'r0',
    'Engram:ingest': 'write',
    'Graph:query': 'r0',
    'Graph:upsert': 'write',
  },
  intake_heuristic: {
    r0_keywords: ['report', 'show', 'query', 'read'],
    write_keywords: ['create', 'update', 'delete', 'ingest'],
  },
};

function makeJob({ targets = [], intake_context = null, description = '' }) {
  return {
    job_urn: 'urn:llm-ops:job:test',
    targets,
    intake_context,
    description,
  };
}

test('phase B: all r0 targets -> r0 lane', () => {
  const sel = createLaneSelector({ table: TEST_TABLE });
  const result = sel.selectLane(makeJob({ targets: ['Radiant:query', 'Engram:read'] }));
  assert.equal(result.lane, 'r0');
  assert.deepEqual(result.r0_targets, ['Radiant:query', 'Engram:read']);
  assert.equal(result.write_targets.length, 0);
});

test('phase B: any write target -> write lane', () => {
  const sel = createLaneSelector({ table: TEST_TABLE });
  const result = sel.selectLane(makeJob({ targets: ['Radiant:query', 'Engram:ingest'] }));
  assert.equal(result.lane, 'write');
  assert.deepEqual(result.write_targets, ['Engram:ingest']);
  assert.deepEqual(result.r0_targets, ['Radiant:query']);
});

test('phase B: unknown target defaults to write and is flagged ambiguous', () => {
  const sel = createLaneSelector({ table: TEST_TABLE });
  const result = sel.selectLane(makeJob({ targets: ['Unknown:action'] }));
  assert.equal(result.lane, 'write');
  assert.deepEqual(result.ambiguous_targets, ['Unknown:action']);
  assert.match(result.reasoning, /unknown-defaulted-to-write/);
});

test('phase B: empty targets -> write lane (fail-closed default)', () => {
  const sel = createLaneSelector({ table: TEST_TABLE });
  const result = sel.selectLane(makeJob({ targets: [] }));
  assert.equal(result.lane, 'write');
  assert.match(result.reasoning, /no-targets-default-fallback/);
});

test('phase A: cortex goal with read keyword -> r0', () => {
  const sel = createLaneSelector({ table: TEST_TABLE });
  const result = sel.selectLane(
    makeJob({
      intake_context: { kind: 'cortex_goal', target_state: 'show me the daily backup report' },
      description: 'show me the daily backup report',
    }),
    { phase: 'preliminary' },
  );
  assert.equal(result.lane, 'r0');
});

test('phase A: cortex goal with write keyword -> pending (defer to drafter)', () => {
  const sel = createLaneSelector({ table: TEST_TABLE });
  const result = sel.selectLane(
    makeJob({
      intake_context: { kind: 'cortex_goal', target_state: 'create a new backup destination' },
      description: 'create a new backup destination',
    }),
    { phase: 'preliminary' },
  );
  assert.equal(result.lane, 'pending');
  assert.match(result.reasoning, /write-keyword-detected/);
});

test('phase A: receptor request with intent_label match', () => {
  const sel = createLaneSelector({ table: TEST_TABLE });
  const result = sel.selectLane(
    makeJob({
      intake_context: { kind: 'receptor_request', intent_label: 'show status' },
      description: 'show status',
    }),
    { phase: 'preliminary' },
  );
  assert.equal(result.lane, 'r0');
});

test('phase A: unknown intake kind -> pending', () => {
  const sel = createLaneSelector({ table: TEST_TABLE });
  const result = sel.selectLane(
    makeJob({ intake_context: { kind: 'mystery' } }),
    { phase: 'preliminary' },
  );
  assert.equal(result.lane, 'pending');
});

test('phase A: no intake_context -> pending', () => {
  const sel = createLaneSelector({ table: TEST_TABLE });
  const result = sel.selectLane(makeJob({}), { phase: 'preliminary' });
  assert.equal(result.lane, 'pending');
});

test('classifyTarget returns the lookup result', () => {
  const sel = createLaneSelector({ table: TEST_TABLE });
  assert.equal(sel.classifyTarget('Radiant:query').lane, 'r0');
  assert.equal(sel.classifyTarget('Engram:ingest').lane, 'write');
  assert.equal(sel.classifyTarget('Unknown:foo').lane, 'write');
  assert.equal(sel.classifyTarget(null).lane, 'write');
});

test('loadClassifierTable returns parsed JSON when file is valid', async () => {
  const realPath = join(__dirname, '..', 'config', 'action-classifier.json');
  const table = await loadClassifierTable(realPath);
  assert.ok(table.actions, 'actions field present');
  assert.ok(Object.keys(table.actions).length > 20, 'comprehensive table loaded');
  assert.equal(table.actions['Radiant:query'], 'r0');
  assert.equal(table.actions['Engram:ingest'], 'write');
});

test('loadClassifierTable returns FALLBACK_TABLE when file is missing', async () => {
  const table = await loadClassifierTable('/nonexistent/path.json');
  assert.deepEqual(table.actions, {});
});

test('FALLBACK behavior with empty table classifies everything as write', () => {
  const sel = createLaneSelector({ table: { actions: {} } });
  const result = sel.selectLane(makeJob({ targets: ['Radiant:query', 'Engram:read'] }));
  assert.equal(result.lane, 'write');
  assert.equal(result.ambiguous_targets.length, 2);
});

test('phase B never returns pending', () => {
  const sel = createLaneSelector({ table: TEST_TABLE });
  // Even with no targets, Phase B returns write (fail-closed), never pending
  const result = sel.selectLane(makeJob({ targets: [] }));
  assert.notEqual(result.lane, 'pending');
});
