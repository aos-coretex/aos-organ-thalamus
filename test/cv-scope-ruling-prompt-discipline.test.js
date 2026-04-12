/**
 * CV: Scope-ruling prompt discipline (BINDING).
 *
 * Same 3-layer pattern as test/ap-drafter-agent.test.js:
 *   Layer 1: SYSTEM_PROMPT exported constant — grep for forbidden phrases
 *   Layer 2: agents/ap-drafter-agent.js file on disk — grep executable content
 *   Layer 3: buildPrompt() output with sample data — grep the composed prompt
 *
 * Forbidden phrases (case-insensitive):
 *   in_scope, out_of_scope, ambiguous, scope ruling, scope check, scope gate,
 *   permitted action, forbidden action
 * Plus uppercase variants: IN_SCOPE, OUT_OF_SCOPE, AMBIGUOUS
 *
 * Per the 2026-04-11 amendment to MP-13: Thalamus reads MSP+BoR for
 * constitutional CONDITIONING. Determinations on the perimeter belong to
 * Arbiter, not the drafter.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SYSTEM_PROMPT, buildPrompt } from '../agents/ap-drafter-agent.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const FORBIDDEN = [
  'in_scope',
  'out_of_scope',
  'ambiguous',
  'scope ruling',
  'scope check',
  'scope gate',
  'permitted action',
  'forbidden action',
  'IN_SCOPE',
  'OUT_OF_SCOPE',
  'AMBIGUOUS',
];

test('CV: SYSTEM_PROMPT contains no scope-ruling language', () => {
  const lowered = SYSTEM_PROMPT.toLowerCase();
  for (const phrase of FORBIDDEN) {
    assert.ok(
      !lowered.includes(phrase.toLowerCase()),
      `SYSTEM_PROMPT contains forbidden phrase: "${phrase}"`,
    );
  }
});

test('CV: ap-drafter-agent.js executable content contains no scope-ruling language', async () => {
  const agentPath = join(__dirname, '..', 'agents', 'ap-drafter-agent.js');
  const content = await readFile(agentPath, 'utf-8');

  // Strip the BINDING comment block (which legitimately enumerates the
  // forbidden phrases as documentation). Find the SYSTEM_PROMPT export and
  // grep only the executable content from there onward.
  const exportIdx = content.indexOf('export const SYSTEM_PROMPT');
  assert.ok(exportIdx > 0, 'SYSTEM_PROMPT export must exist in ap-drafter-agent.js');
  const executable = content.slice(exportIdx).toLowerCase();

  for (const phrase of FORBIDDEN) {
    assert.ok(
      !executable.includes(phrase.toLowerCase()),
      `executable content of ap-drafter-agent.js contains forbidden phrase: "${phrase}"`,
    );
  }
});

test('CV: buildPrompt output contains no scope-ruling language', () => {
  const sampleMission = {
    msp: { version: '1.0.0', hash: 'h1', raw_text: '# MSP\nMission: build the organism' },
    bor: { version: '1.0.0', hash: 'h2', raw_text: '# BoR\nRights: do no harm' },
  };
  const sampleJob = {
    job_urn: 'urn:llm-ops:job:cv-scope',
    source: 'cortex',
    description: 'test goal for scope discipline',
    priority: 'medium',
    intake_context: { kind: 'cortex_goal', target_state: 'verified', severity: 0.5, source_category: 'operational' },
  };
  const sampleEvidence = [
    { source: 'Radiant', content: 'evidence content', urn: 'urn:r:1' },
  ];

  const prompt = buildPrompt({
    jobRecord: sampleJob,
    missionFrame: sampleMission,
    evidence: sampleEvidence,
    graphContext: null,
  });

  const lowered = prompt.toLowerCase();
  for (const phrase of FORBIDDEN) {
    assert.ok(
      !lowered.includes(phrase.toLowerCase()),
      `buildPrompt output contains forbidden phrase: "${phrase}"`,
    );
  }
});
