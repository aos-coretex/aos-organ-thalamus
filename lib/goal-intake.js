/**
 * Goal intake — consumes Cortex `autonomous_goal` OTMs and creates JobRecords.
 *
 * The envelope shape this handler consumes is THE CONTRACT LOCKED by
 * AOS-organ-cortex-src/test/cv-goal-delivery.test.js. Every field this handler
 * reads must exist in that test's KNOWN_GAP fixture, OR the handler must treat
 * it as optional with a documented fallback. Do NOT add new required fields
 * here without first updating the Cortex contract test (which would be a
 * cross-MP change requiring its own RFI).
 *
 * Required envelope fields (per cv-goal-delivery.test.js BINDING assertions):
 *   envelope.type === 'OTM'
 *   envelope.source_organ === 'Cortex'
 *   envelope.target_organ === 'Thalamus'
 *   envelope.reply_to === 'Cortex'
 *   envelope.payload.event_type === 'autonomous_goal'
 *   envelope.payload.goal_id        (URN)
 *   envelope.payload.gap_ref        (URN)
 *   envelope.payload.description    (string)
 *   envelope.payload.target_state   (string)
 *   envelope.payload.priority       ('low' | 'medium' | 'high' | 'critical')
 *   envelope.payload.mission_ref    (string)
 *   envelope.payload.evidence_refs  (array of URN strings)
 *   envelope.payload.severity       (number 0..1)
 *   envelope.payload.source_category (string)
 *   envelope.payload.assessment_context.{msp_version, msp_hash, bor_version, bor_hash, assessed_at, cortex_iteration}
 *
 * Optional envelope fields:
 *   envelope.payload.deadline_context  (object | null)
 *   envelope.payload.suggested_approach (string | null)
 *
 * Malformed envelope handling:
 *   - Missing envelope.payload OR missing event_type:                       reject ('malformed_envelope')
 *   - envelope.source_organ !== 'Cortex':                                   reject ('wrong_source_organ')
 *   - envelope.payload.event_type !== 'autonomous_goal':                    reject ('wrong_event_type')
 *   - envelope.payload.goal_id missing OR not URN format:                   reject ('invalid_goal_id')
 *   - envelope.payload.description missing:                                 reject ('missing_description')
 *   - envelope.payload.priority missing OR not in valid set:                normalize to 'medium' + log
 *
 * Return shape: { handled, job_urn?, error? }
 *
 * Side effect: emits job_record_created lifecycle ack back to Cortex via the
 * lifecycle-ack-emitter. Best-effort — ack failure does not affect the return.
 */

const VALID_PRIORITIES = ['low', 'medium', 'high', 'critical'];

// MP-17 relay g7c-6 — Cortex-sourced APMs default to platform tenant per
// MP-17 §"Cortex-sourced APMs carry `tenant_type = platform` by default".
// This mapping is done IN THALAMUS, not in Cortex source (Cortex is
// read-only per the relay guardrail). Canonical entity-URN form per RFI-1
// Q3 = `urn:llm-ops:entity:llm-ops-platform`.
const CORTEX_PATH_DEFAULT_TENANT = Object.freeze({
  tenant_urn: 'urn:llm-ops:entity:llm-ops-platform',
  tenant_type: 'platform',
});

function log(event, data = {}) {
  const entry = { timestamp: new Date().toISOString(), organ: 'Thalamus', event, ...data };
  process.stdout.write(JSON.stringify(entry) + '\n');
}

export function createGoalIntake({ jobLifecycle, lifecycleAckEmitter }) {
  async function handleGoalEnvelope(envelope) {
    // --- Envelope-level validation ---

    if (!envelope?.payload) {
      log('thalamus_goal_intake_rejected', { reason: 'malformed_envelope', message_id: envelope?.message_id });
      return { handled: false, error: 'malformed_envelope' };
    }
    if (envelope.source_organ !== 'Cortex') {
      log('thalamus_goal_intake_rejected', {
        reason: 'wrong_source_organ',
        source_organ: envelope.source_organ,
        message_id: envelope.message_id,
      });
      return { handled: false, error: 'wrong_source_organ' };
    }
    if (envelope.payload.event_type !== 'autonomous_goal') {
      log('thalamus_goal_intake_rejected', {
        reason: 'wrong_event_type',
        event_type: envelope.payload.event_type,
        message_id: envelope.message_id,
      });
      return { handled: false, error: 'wrong_event_type' };
    }

    const p = envelope.payload;

    // --- Payload-level validation ---

    if (typeof p.goal_id !== 'string' || !p.goal_id.startsWith('urn:llm-ops:goal:')) {
      log('thalamus_goal_intake_rejected', { reason: 'invalid_goal_id', goal_id: p.goal_id });
      return { handled: false, error: 'invalid_goal_id' };
    }
    if (typeof p.description !== 'string' || p.description.length === 0) {
      log('thalamus_goal_intake_rejected', { reason: 'missing_description', goal_id: p.goal_id });
      return { handled: false, error: 'missing_description' };
    }

    // --- Priority normalization ---

    let priority = p.priority;
    if (!VALID_PRIORITIES.includes(priority)) {
      log('thalamus_goal_intake_priority_normalized', { from: priority, to: 'medium', goal_id: p.goal_id });
      priority = 'medium';
    }

    // --- Create the JobRecord ---

    let jobRecord;
    try {
      jobRecord = await jobLifecycle.createJob({
        source: 'cortex',
        originator_ref: envelope.message_id,
        reply_to: envelope.reply_to || 'Cortex', // contract requires reply_to='Cortex' but defend against drift
        priority,
        description: p.description,
        // MP-17 relay g7c-6 — Cortex-path platform default
        tenant_urn: CORTEX_PATH_DEFAULT_TENANT.tenant_urn,
        tenant_type: CORTEX_PATH_DEFAULT_TENANT.tenant_type,
      });
    } catch (err) {
      log('thalamus_goal_intake_create_failed', { error: err.message, goal_id: p.goal_id });
      return { handled: false, error: `job_create_failed: ${err.message}` };
    }

    // --- Carry forward Cortex enrichments into the cached JobRecord ---

    jobLifecycle.enrichIntakeContext(jobRecord.job_urn, {
      mission_ref: p.mission_ref,
      evidence_refs: p.evidence_refs || [],
      assessment_context: p.assessment_context || null,
      intake_context: {
        kind: 'cortex_goal',
        goal_id: p.goal_id,
        gap_ref: p.gap_ref,
        target_state: p.target_state,
        severity: p.severity,
        source_category: p.source_category,
        cortex_iteration: p.assessment_context?.cortex_iteration || null,
        deadline_context: p.deadline_context || null,
        suggested_approach: p.suggested_approach || null,
      },
    });

    log('thalamus_goal_intake_accepted', {
      job_urn: jobRecord.job_urn,
      goal_id: p.goal_id,
      priority,
      description_preview: p.description.slice(0, 80),
    });

    // --- Emit job_record_created lifecycle ack to Cortex ---

    const updated = jobLifecycle.getJob(jobRecord.job_urn);
    await lifecycleAckEmitter.emit('job_record_created', { jobRecord: updated });

    return { handled: true, job_urn: jobRecord.job_urn };
  }

  return handleGoalEnvelope;
}
