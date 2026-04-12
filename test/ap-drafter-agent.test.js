import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SYSTEM_PROMPT, buildPrompt, parseResponse } from '../agents/ap-drafter-agent.js';

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

test('SYSTEM_PROMPT contains no scope-ruling language', () => {
  const lowered = SYSTEM_PROMPT.toLowerCase();
  for (const phrase of FORBIDDEN) {
    assert.ok(!lowered.includes(phrase.toLowerCase()), `SYSTEM_PROMPT contains forbidden phrase: "${phrase}"`);
  }
});

test('agents/ap-drafter-agent.js file content contains no scope-ruling language', async () => {
  const agentPath = join(__dirname, '..', 'agents', 'ap-drafter-agent.js');
  const content = await readFile(agentPath, 'utf-8');
  // Strip the BINDING comment block (which legitimately enumerates the
  // forbidden phrases as documentation). Find the SYSTEM_PROMPT export and
  // grep only the executable content from there onward.
  const exportIdx = content.indexOf('export const SYSTEM_PROMPT');
  assert.ok(exportIdx > 0, 'SYSTEM_PROMPT export must exist');
  const executable = content.slice(exportIdx).toLowerCase();
  for (const phrase of FORBIDDEN) {
    assert.ok(!executable.includes(phrase.toLowerCase()), `executable content of ap-drafter-agent.js contains forbidden phrase: "${phrase}"`);
  }
});

test('buildPrompt output contains no scope-ruling language', () => {
  const sampleMission = {
    msp: { version: '1.0.0', hash: 'h1', raw_text: '# MSP\nMission: build the organism' },
    bor: { version: '1.0.0', hash: 'h2', raw_text: '# BoR\nRights: do no harm' },
  };
  const sampleJob = {
    job_urn: 'urn:llm-ops:job:test',
    source: 'cortex',
    description: 'test',
    priority: 'medium',
    intake_context: { kind: 'cortex_goal', target_state: 'x', severity: 0.5, source_category: 'op' },
  };
  const sampleEvidence = [{ source: 'Radiant', content: 'evidence content', urn: 'urn:r:1' }];
  const prompt = buildPrompt({ jobRecord: sampleJob, missionFrame: sampleMission, evidence: sampleEvidence, graphContext: null });
  const lowered = prompt.toLowerCase();
  for (const phrase of FORBIDDEN) {
    assert.ok(!lowered.includes(phrase.toLowerCase()), `buildPrompt output contains forbidden phrase: "${phrase}"`);
  }
});

test('parseResponse parses a well-formed AP JSON', () => {
  const validJson = JSON.stringify({
    action: 'Re-run nightly backup',
    reason: 'Backups have not run for 8 days; mission requires daily',
    targets: ['SafeVault:backup'],
    risk_tier: 'medium',
    rollback_plan: 'Backup is read-only on source; nothing to roll back',
    execution_plan: {
      targets: ['urn:llm-ops:safevault:nas-01'],
      action_type: 'safevault_backup_run',
      credential_name: 'coretex.cerberus.safevault_writer',
      conditionState: { backup_window_open: true },
      payload: { dry_run: false },
    },
    evidence_refs: ['urn:llm-ops:radiant:block:42'],
  });
  const { ap, error } = parseResponse(validJson);
  assert.equal(error, null);
  assert.equal(ap.action, 'Re-run nightly backup');
  assert.equal(ap.risk_tier, 'medium');
  assert.deepEqual(ap.targets, ['SafeVault:backup']);
  assert.equal(ap.execution_plan.action_type, 'safevault_backup_run');
});

test('parseResponse strips markdown fences', () => {
  const fenced = '```json\n{"action":"x","reason":"y","targets":["a:b"],"risk_tier":"low","rollback_plan":"r","execution_plan":{"targets":["urn:1"],"action_type":"t","credential_name":"c"}}\n```';
  const { ap, error } = parseResponse(fenced);
  assert.equal(error, null);
  assert.equal(ap.action, 'x');
});

test('parseResponse returns parse error on malformed JSON', () => {
  const { ap, error } = parseResponse('{not valid json');
  assert.equal(ap, null);
  assert.match(error, /json_parse_error/);
});

test('parseResponse rejects missing required field', () => {
  const missingAction = JSON.stringify({
    reason: 'r',
    targets: [],
    risk_tier: 'low',
    rollback_plan: 'r',
    execution_plan: { targets: [], action_type: 't', credential_name: 'c' },
  });
  const { ap, error } = parseResponse(missingAction);
  assert.equal(ap, null);
  assert.equal(error, 'missing_field: action');
});

test('parseResponse rejects invalid risk_tier', () => {
  const bad = JSON.stringify({
    action: 'a', reason: 'r', targets: [], risk_tier: 'extreme', rollback_plan: 'r',
    execution_plan: { targets: [], action_type: 't', credential_name: 'c' },
  });
  const { ap, error } = parseResponse(bad);
  assert.equal(ap, null);
  assert.match(error, /invalid_risk_tier/);
});

test('parseResponse rejects missing execution_plan field', () => {
  const bad = JSON.stringify({
    action: 'a', reason: 'r', targets: [], risk_tier: 'low', rollback_plan: 'r',
    execution_plan: { targets: [], action_type: 't' /* missing credential_name */ },
  });
  const { ap, error } = parseResponse(bad);
  assert.equal(ap, null);
  assert.equal(error, 'missing_execution_plan_field: credential_name');
});

test('parseResponse defaults conditionState and payload to {}', () => {
  const minimal = JSON.stringify({
    action: 'a', reason: 'r', targets: [], risk_tier: 'low', rollback_plan: 'r',
    execution_plan: { targets: ['urn:1'], action_type: 't', credential_name: 'c' },
  });
  const { ap } = parseResponse(minimal);
  assert.deepEqual(ap.execution_plan.conditionState, {});
  assert.deepEqual(ap.execution_plan.payload, {});
});

test('parseResponse handles empty_response', () => {
  const { ap, error } = parseResponse('');
  assert.equal(ap, null);
  assert.equal(error, 'empty_response');
});
