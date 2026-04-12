import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractUrnSeeds } from '../lib/urn-seeds.js';

test('Cortex job: extracts evidence_refs and gap_ref', () => {
  const job = {
    evidence_refs: ['urn:llm-ops:radiant:block:1', 'urn:llm-ops:spine:transition:2'],
    intake_context: { kind: 'cortex_goal', gap_ref: 'urn:llm-ops:cortex-gap:42' },
  };
  const seeds = extractUrnSeeds(job);
  assert.equal(seeds.length, 3);
  assert.ok(seeds.includes('urn:llm-ops:cortex-gap:42'));
});

test('Receptor job: extracts payload_urn, intent_urn, user_identity', () => {
  const job = {
    evidence_refs: [],
    intake_context: {
      kind: 'receptor_request',
      payload_urn: 'urn:llm-ops:payload:1',
      intent_urn: 'urn:llm-ops:intent:question',
      user_identity: 'urn:llm-ops:user:leon',
    },
  };
  const seeds = extractUrnSeeds(job);
  assert.equal(seeds.length, 3);
});

test('Receptor job: skips user_identity if not URN format', () => {
  const job = {
    evidence_refs: [],
    intake_context: { kind: 'receptor_request', user_identity: 'leon' },
  };
  assert.deepEqual(extractUrnSeeds(job), []);
});

test('deduplicates repeated URNs', () => {
  const job = {
    evidence_refs: ['urn:llm-ops:x:1', 'urn:llm-ops:x:1'],
    intake_context: { kind: 'cortex_goal', gap_ref: 'urn:llm-ops:x:1' },
  };
  assert.deepEqual(extractUrnSeeds(job), ['urn:llm-ops:x:1']);
});

test('null jobRecord returns empty array', () => {
  assert.deepEqual(extractUrnSeeds(null), []);
});

test('missing intake_context returns evidence_refs only', () => {
  const job = { evidence_refs: ['urn:llm-ops:x:1'] };
  assert.deepEqual(extractUrnSeeds(job), ['urn:llm-ops:x:1']);
});

test('non-URN strings in evidence_refs are filtered', () => {
  const job = { evidence_refs: ['urn:llm-ops:x:1', 'not-a-urn', 42, null] };
  assert.deepEqual(extractUrnSeeds(job), ['urn:llm-ops:x:1']);
});
