/**
 * Re-exported canonical Cortex -> Thalamus envelope fixture.
 * Lifted from AOS-organ-cortex-src/test/cv-goal-delivery.test.js KNOWN_GAP.
 * Used across CV tests to assert contract fidelity.
 */
export function makeCanonicalCortexEnvelope() {
  return {
    type: 'OTM',
    source_organ: 'Cortex',
    target_organ: 'Thalamus',
    reply_to: 'Cortex',
    message_id: 'urn:llm-ops:otm:test-cortex-cv',
    payload: {
      event_type: 'autonomous_goal',
      goal_id: 'urn:llm-ops:goal:1744380000000-0-known1',
      gap_ref: 'urn:llm-ops:cortex-gap:1744380000000-0-known1',
      description: 'known test gap — backups have not run in 8 days',
      target_state: 'Daily backup cycle resumed',
      priority: 'high',
      mission_ref: 'MSP §Operational Continuity',
      evidence_refs: ['urn:llm-ops:radiant:block:42', 'urn:llm-ops:spine:transition:99'],
      severity: 0.85,
      source_category: 'operational',
      assessment_context: {
        msp_version: '1.0.0-seed',
        msp_hash: 'msp-known-hash',
        bor_version: '1.0.0',
        bor_hash: 'bor-known-hash',
        assessed_at: '2026-04-11T12:00:00Z',
        cortex_iteration: 7,
      },
      deadline_context: null,
      suggested_approach: null,
    },
  };
}

export function makeCanonicalReceptorEnvelope() {
  return {
    type: 'OTM',
    source_organ: 'Receptor',
    target_organ: 'Thalamus',
    reply_to: 'Receptor',
    message_id: 'urn:llm-ops:otm:test-receptor-cv',
    payload: {
      event_type: 'ingress_request',
      payload_urn: 'urn:llm-ops:payload:test-cv',
      intent_urn: 'urn:llm-ops:intent:question',
      intent_label: 'question',
      channel: 'axon',
      session_id: 'urn:llm-ops:session:test-cv',
      user_identity: 'urn:llm-ops:user:leon',
      message: { text: 'how many backups ran today?' },
      classification_confidence: 0.92,
    },
  };
}

export const VALID_AP_JSON = JSON.stringify({
  action: 'Re-run nightly backup',
  reason: 'Backups have not run for 8 days',
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
