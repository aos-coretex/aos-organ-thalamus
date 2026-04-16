/**
 * Job lifecycle controller.
 *
 * Write-through orchestration over spine-state + the in-memory cache. Every
 * lifecycle method:
 *   1. Validates the requested transition is legal under the spine-state
 *      `job` machine (defensive — spine-state will 409 invalid transitions
 *      anyway, but local validation gives a clearer error and avoids the
 *      round trip).
 *   2. Calls the spine-state client (POST /entities for creation, POST
 *      /:urn/transition for state changes).
 *   3. Updates the in-memory cache.
 *   4. Logs a structured event for Lobe / observability.
 *
 * Idempotency: replaying a transition that's already been applied is a no-op.
 * The controller checks the cache state BEFORE issuing the spine-state HTTP
 * call. If the cache state already matches the requested target, return the
 * existing record without side effects. This protects against duplicate
 * message delivery from Spine.
 *
 * Reason field: each transition encodes the enrichment delta as JSON in the
 * `reason` field of the spine-state transition. This is the persistent audit
 * trail — spine-state retains every transition with timestamp and reason, so
 * the full job history is reconstructable from spine-state alone (the in-memory
 * cache is a convenience).
 *
 * Exception types (per organ definition S6):
 *   - JOB_STATE_CONFLICT: spine-state rejects a transition (409). Logged + thrown.
 *   - SpineStateError: any other spine-state HTTP failure. Wrapped + thrown.
 */

import { generateUrn } from '@coretex/organ-boot/urn';

function log(event, data = {}) {
  const entry = { timestamp: new Date().toISOString(), organ: 'Thalamus', event, ...data };
  process.stdout.write(JSON.stringify(entry) + '\n');
}

// Locally-mirrored transition graph (defensive validation; AUTHORITATIVE
// definition lives in AOS-organ-spine-src/server/state/definitions.js).
// If spine-state's definition diverges, the local check fails fast and the
// drift is visible — better than silently letting spine-state 409 the call.
const VALID_TRANSITIONS = {
  CREATED:       ['PLANNING'],
  PLANNING:      ['AWAITING_AUTH', 'DISPATCHED'],
  AWAITING_AUTH: ['DISPATCHED', 'DENIED'],
  DISPATCHED:    ['EXECUTING'],
  EXECUTING:     ['SUCCEEDED', 'FAILED'],
};
const TERMINAL_STATES = ['SUCCEEDED', 'DENIED', 'FAILED'];

function isLegalTransition(from, to) {
  return VALID_TRANSITIONS[from]?.includes(to) || false;
}

export function createJobLifecycle({ spineStateClient, jobStore }) {
  // ----- creation -----

  async function createJob({ source, originator_ref, reply_to, priority, description, tenant_urn, tenant_type }) {
    const jobUrn = generateUrn('job');
    const nowIso = new Date().toISOString();

    const jobRecord = {
      job_urn: jobUrn,
      source,
      originator_ref,
      reply_to,
      priority: priority || 'medium',
      description: description || '',
      state: 'CREATED',
      lane: 'pending',
      created_at: nowIso,
      updated_at: nowIso,
      mission_frame_ref: null,
      evidence_refs: [],
      graph_context: null,
      risk_tier: null,
      rollback_plan: null,
      targets: [],
      execution_plan: null,
      ap_ref: null,
      token_urn: null,
      execution_id: null,
      result: null,
      denial_reason: null,
      error: null,
      // Intake enrichment fields (set by enrichIntakeContext in t3q-2)
      mission_ref: null,
      assessment_context: null,
      intake_context: null,
      // MP-17 relay g7c-6 — tenant context persisted at creation time.
      // Top-level (not inside execution_plan) so atm-forwarder can rehydrate
      // execution_request.tenant_urn directly from the JobRecord without
      // depending on execution_plan having been populated by the AP drafter.
      // Thalamus intake is the ONLY write path for these fields — APM payload
      // and ATM execution_request both rehydrate from here.
      tenant_urn: tenant_urn || null,
      tenant_type: tenant_type || null,
    };

    // Persist creation in spine-state — entity metadata captures the immutable
    // creation-time fields.
    const creationMetadata = {
      source,
      originator_ref,
      reply_to,
      priority: jobRecord.priority,
      description: jobRecord.description,
      created_by: 'Thalamus',
      tenant_urn: jobRecord.tenant_urn,
      tenant_type: jobRecord.tenant_type,
    };
    await spineStateClient.createJobEntity(jobUrn, creationMetadata);

    jobStore.add(jobRecord);
    log('thalamus_job_created', {
      job_urn: jobUrn,
      source,
      originator_ref,
      priority: jobRecord.priority,
      tenant_type: jobRecord.tenant_type,
    });

    return jobRecord;
  }

  // ----- helper for transitions -----

  async function applyTransition(jobUrn, toState, patch, reasonObj) {
    const job = jobStore.get(jobUrn);
    if (!job) throw new Error(`job_not_found: ${jobUrn}`);

    // Idempotency: if we're already at the target, no-op (cache + spine-state
    // are presumed consistent — see Awareness S5).
    if (job.state === toState) {
      log('thalamus_transition_idempotent', { job_urn: jobUrn, state: toState });
      return job;
    }

    if (!isLegalTransition(job.state, toState)) {
      const err = new Error(`JOB_STATE_CONFLICT: ${job.state} -> ${toState}`);
      err.code = 'JOB_STATE_CONFLICT';
      log('thalamus_job_state_conflict', { job_urn: jobUrn, from: job.state, to: toState });
      throw err;
    }

    const reasonStr = JSON.stringify({ to_state: toState, ...reasonObj });
    await spineStateClient.transitionJob(jobUrn, job.state, toState, reasonStr);

    const updated = jobStore.update(jobUrn, { state: toState, ...patch });
    log('thalamus_job_transitioned', { job_urn: jobUrn, from: job.state, to: toState, lane: updated.lane });
    return updated;
  }

  // ----- transition methods -----

  async function markPlanning(jobUrn) {
    return applyTransition(jobUrn, 'PLANNING', {}, { phase: 'planning_started' });
  }

  async function markAwaitingAuth(jobUrn, { ap_ref, risk_tier, rollback_plan, targets, evidence_refs, mission_frame_ref, execution_plan }) {
    return applyTransition(
      jobUrn,
      'AWAITING_AUTH',
      { ap_ref, risk_tier, rollback_plan, targets, evidence_refs, mission_frame_ref, execution_plan, lane: 'write' },
      { ap_ref, risk_tier },
    );
  }

  async function markDispatched(jobUrn, { token_urn = null, target_organs = [] } = {}) {
    return applyTransition(
      jobUrn,
      'DISPATCHED',
      { token_urn, dispatched_to: target_organs },
      { token_urn, target_organs },
    );
  }

  async function markExecuting(jobUrn, { execution_id = null } = {}) {
    return applyTransition(jobUrn, 'EXECUTING', { execution_id }, { execution_id });
  }

  async function markSucceeded(jobUrn, { result } = {}) {
    return applyTransition(jobUrn, 'SUCCEEDED', { result }, { result_summary: result?.summary || null });
  }

  async function markDenied(jobUrn, { reason }) {
    return applyTransition(jobUrn, 'DENIED', { denial_reason: reason }, { denial_reason: reason });
  }

  async function markFailed(jobUrn, { error }) {
    return applyTransition(jobUrn, 'FAILED', { error }, { error });
  }

  // ----- intake enrichment (t3q-2) -----

  function enrichIntakeContext(jobUrn, intakeFields) {
    const job = jobStore.get(jobUrn);
    if (!job) {
      throw new Error(`job_not_found: ${jobUrn}`);
    }
    // Patch only the intake-specific fields. State, lane, ap_ref, token_urn,
    // result, etc. are untouched — they belong to the lifecycle path.
    jobStore.update(jobUrn, {
      mission_ref: intakeFields.mission_ref,
      evidence_refs: intakeFields.evidence_refs,
      assessment_context: intakeFields.assessment_context,
      intake_context: intakeFields.intake_context,
    });
    log('thalamus_job_enriched', { job_urn: jobUrn, kind: intakeFields.intake_context?.kind });
    return jobStore.get(jobUrn);
  }

  // ----- lane enrichment (t3q-4) -----

  function setLane(jobUrn, lane) {
    const validLanes = ['pending', 'r0', 'write'];
    if (!validLanes.includes(lane)) {
      throw new Error(`invalid_lane: ${lane}`);
    }
    const job = jobStore.get(jobUrn);
    if (!job) throw new Error(`job_not_found: ${jobUrn}`);
    jobStore.update(jobUrn, { lane });
    log('thalamus_job_lane_set', { job_urn: jobUrn, lane });
    return jobStore.get(jobUrn);
  }

  // ----- read accessors (delegated to job-store) -----

  function getJob(jobUrn) {
    return jobStore.get(jobUrn);
  }

  function listJobs(query) {
    return jobStore.list(query);
  }

  return {
    createJob,
    markPlanning,
    markAwaitingAuth,
    markDispatched,
    markExecuting,
    markSucceeded,
    markDenied,
    markFailed,
    enrichIntakeContext,
    setLane,
    getJob,
    listJobs,
    // Exposed for tests
    isLegalTransition,
    TERMINAL_STATES,
  };
}
