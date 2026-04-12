/**
 * Dispatcher — top-level orchestrator for write-lane and R0-lane execution.
 *
 * Composes atm-forwarder, r0-dispatcher, jobLifecycle, and lifecycle-ack-emitter
 * into the full execution flow. Also hosts the Nomos ruling consumer
 * (handleAdjudicationResult / handleAdjudicationHeld / handleApmRejected) and
 * the Cerberus broadcast consumers (handleExecutionCompleted / handleExecutionDenied
 * / handleExecutionFailed).
 *
 * R0 dispatch uses direct HTTP (ARCHITECTURAL DEVIATION from meta prompt — see
 * relay t3q-6 S1). Spine OTM broadcasts are emitted for observability.
 */

function log(event, data = {}) {
  const entry = { timestamp: new Date().toISOString(), organ: 'Thalamus', event, ...data };
  process.stdout.write(JSON.stringify(entry) + '\n');
}

function findJobByApRef(jobLifecycle, apRef) {
  const jobs = jobLifecycle.listJobs({ limit: 1000 });
  return jobs.find(j => j.ap_ref === apRef) || null;
}

function findJobByTokenUrn(jobLifecycle, tokenUrn) {
  const jobs = jobLifecycle.listJobs({ limit: 1000 });
  return jobs.find(j => j.token_urn === tokenUrn) || null;
}

export function createDispatcher({
  jobLifecycle,
  atmForwarder,
  r0Dispatcher,
  lifecycleAckEmitter,
}) {
  // ----- Write-lane: ATM arrival -> forward to Cerberus -----

  async function dispatchWriteAfterAuth({ atmEnvelope }) {
    const apRef = atmEnvelope?.payload?.ap_ref;
    if (!apRef) {
      log('thalamus_atm_received_no_ap_ref');
      return { dispatched: false, error: 'no_ap_ref_in_atm' };
    }

    const jobRecord = findJobByApRef(jobLifecycle, apRef);
    if (!jobRecord) {
      log('thalamus_atm_no_matching_job', { ap_ref: apRef });
      return { dispatched: false, error: 'job_not_found_for_ap_ref' };
    }

    log('thalamus_atm_received', {
      job_urn: jobRecord.job_urn,
      ap_ref: apRef,
      token_urn: atmEnvelope.payload.token_urn,
    });

    const result = await atmForwarder.forwardAtm({ jobRecord, atmEnvelope });
    if (!result.forwarded) {
      try {
        // Job is in AWAITING_AUTH — the only valid terminal from here is DENIED.
        // ATM forwarding failure is treated as an infrastructure denial.
        await jobLifecycle.markDenied(jobRecord.job_urn, { reason: `atm_forward_failed: ${result.error}` });
      } catch (err) {
        log('thalamus_dispatch_post_failure_transition_failed', { error: err.message });
      }
      const updated = jobLifecycle.getJob(jobRecord.job_urn);
      await lifecycleAckEmitter.emit('job_failed', { jobRecord: updated, extra: { error: result.error } });
      return { dispatched: false, error: result.error };
    }

    const updated = jobLifecycle.getJob(jobRecord.job_urn);
    await lifecycleAckEmitter.emit('job_dispatched', {
      jobRecord: updated,
      extra: { token_urn: atmEnvelope.payload.token_urn, target_organs: ['Cerberus'] },
    });

    return { dispatched: true, target: 'Cerberus', forwarded_message_id: result.forwarded_message_id };
  }

  // ----- R0 lane: PLANNING -> direct dispatch (DEVIATION — see t3q-6 S1) -----

  async function dispatchR0({ jobRecord, targets }) {
    if (jobRecord.lane !== 'r0') {
      log('thalamus_r0_dispatch_wrong_lane', { job_urn: jobRecord.job_urn, lane: jobRecord.lane });
      return { dispatched: false, error: 'lane_not_r0' };
    }

    try {
      await jobLifecycle.markDispatched(jobRecord.job_urn, { target_organs: targets.map(t => t.split(':')[0]) });
    } catch (err) {
      log('thalamus_r0_pre_dispatch_transition_failed', { error: err.message });
      return { dispatched: false, error: err.message };
    }

    const dispatchedJob = jobLifecycle.getJob(jobRecord.job_urn);
    await lifecycleAckEmitter.emit('job_dispatched', {
      jobRecord: dispatchedJob,
      extra: { target_organs: targets.map(t => t.split(':')[0]), lane: 'r0' },
    });

    await jobLifecycle.markExecuting(jobRecord.job_urn);

    const result = await r0Dispatcher.dispatchAll(jobRecord, targets);

    if (result.failures.length > 0 && result.results.length === 0) {
      await jobLifecycle.markFailed(jobRecord.job_urn, {
        error: `r0_all_targets_failed: ${result.failures.map(f => f.target).join(', ')}`,
      });
      const failedJob = jobLifecycle.getJob(jobRecord.job_urn);
      await lifecycleAckEmitter.emit('job_failed', {
        jobRecord: failedJob,
        extra: { failures: result.failures },
      });
      return { dispatched: true, completed: false, results: result.results, failures: result.failures };
    }

    await jobLifecycle.markSucceeded(jobRecord.job_urn, {
      result: { results: result.results, failures: result.failures, total: result.total, summary: `r0 read ${result.results.length}/${result.total} ok` },
    });
    const succeededJob = jobLifecycle.getJob(jobRecord.job_urn);
    await lifecycleAckEmitter.emit('job_completed', {
      jobRecord: succeededJob,
      extra: { result_count: result.results.length, failure_count: result.failures.length },
    });
    return { dispatched: true, completed: true, results: result.results, failures: result.failures };
  }

  // ----- Nomos OTM consumers -----

  async function handleAdjudicationResult({ envelope }) {
    const apRef = envelope?.payload?.ap_ref;
    const ruling = envelope?.payload?.ruling;
    const jobRecord = findJobByApRef(jobLifecycle, apRef);
    if (!jobRecord) {
      log('thalamus_adjudication_result_no_job', { ap_ref: apRef, ruling });
      return { handled: false, error: 'job_not_found' };
    }
    log('thalamus_adjudication_result', { job_urn: jobRecord.job_urn, ap_ref: apRef, ruling });

    if (ruling === 'Authorized' || ruling === 'Authorized-with-Conditions') {
      return { handled: true, status: 'awaiting_atm' };
    }

    if (ruling === 'Denied') {
      try {
        await jobLifecycle.markDenied(jobRecord.job_urn, { reason: envelope.payload.reason || 'denied_by_nomos' });
      } catch (err) {
        log('thalamus_denied_transition_failed', { error: err.message });
      }
      const updated = jobLifecycle.getJob(jobRecord.job_urn);
      await lifecycleAckEmitter.emit('job_failed', { jobRecord: updated, extra: { ruling: 'Denied', reason: envelope.payload.reason } });
      return { handled: true, status: 'denied' };
    }

    if (ruling === 'Escalate') {
      log('thalamus_job_escalated', { job_urn: jobRecord.job_urn, per_ref: envelope.payload.per_ref });
      return { handled: true, status: 'escalated' };
    }

    log('thalamus_unknown_ruling', { ruling });
    return { handled: false, error: `unknown_ruling: ${ruling}` };
  }

  async function handleAdjudicationHeld({ envelope }) {
    const apRef = envelope?.payload?.ap_ref;
    const jobRecord = findJobByApRef(jobLifecycle, apRef);
    if (!jobRecord) return { handled: false, error: 'job_not_found' };
    log('thalamus_evidence_request_received', {
      job_urn: jobRecord.job_urn,
      ap_ref: apRef,
      missing_evidence: envelope.payload.missing_evidence,
    });
    return { handled: true, status: 'held' };
  }

  async function handleApmRejected({ envelope }) {
    const apRef = envelope?.payload?.ap_ref;
    const jobRecord = findJobByApRef(jobLifecycle, apRef);
    if (!jobRecord) return { handled: false, error: 'job_not_found' };
    log('thalamus_apm_rejected', { job_urn: jobRecord.job_urn, reason: envelope.payload.reason });
    try {
      // AWAITING_AUTH -> DENIED is the only valid terminal from AWAITING_AUTH.
      // APM rejection is semantically a Nomos denial.
      await jobLifecycle.markDenied(jobRecord.job_urn, { reason: `nomos_apm_rejected: ${envelope.payload.reason}` });
    } catch (err) {
      log('thalamus_apm_rejected_transition_failed', { error: err.message });
    }
    const updated = jobLifecycle.getJob(jobRecord.job_urn);
    await lifecycleAckEmitter.emit('job_failed', { jobRecord: updated, extra: { reason: envelope.payload.reason } });
    return { handled: true };
  }

  // ----- Cerberus broadcast consumers -----

  async function handleExecutionCompleted({ envelope }) {
    const tokenUrn = envelope?.payload?.token_urn;
    const executionId = envelope?.payload?.execution_id;
    const jobRecord = findJobByTokenUrn(jobLifecycle, tokenUrn);
    if (!jobRecord) {
      return { handled: false, reason: 'not_our_token' };
    }
    log('thalamus_execution_completed', { job_urn: jobRecord.job_urn, execution_id: executionId });

    try {
      if (jobRecord.state === 'DISPATCHED') {
        await jobLifecycle.markExecuting(jobRecord.job_urn, { execution_id: executionId });
      }
      await jobLifecycle.markSucceeded(jobRecord.job_urn, {
        result: { execution_id: executionId, summary: 'cerberus_execution_succeeded', detail: envelope.payload },
      });
    } catch (err) {
      log('thalamus_execution_completed_transition_failed', { error: err.message });
    }
    const updated = jobLifecycle.getJob(jobRecord.job_urn);
    await lifecycleAckEmitter.emit('job_completed', { jobRecord: updated, extra: { execution_id: executionId } });
    return { handled: true };
  }

  async function handleExecutionDenied({ envelope }) {
    const tokenUrn = envelope?.payload?.token_urn;
    const reason = envelope?.payload?.reason;
    const jobRecord = findJobByTokenUrn(jobLifecycle, tokenUrn);
    if (!jobRecord) return { handled: false, reason: 'not_our_token' };
    log('thalamus_execution_denied', { job_urn: jobRecord.job_urn, reason });
    try {
      if (jobRecord.state === 'DISPATCHED') await jobLifecycle.markExecuting(jobRecord.job_urn);
      await jobLifecycle.markFailed(jobRecord.job_urn, { error: `cerberus_denied: ${reason}` });
    } catch (err) {
      log('thalamus_execution_denied_transition_failed', { error: err.message });
    }
    const updated = jobLifecycle.getJob(jobRecord.job_urn);
    await lifecycleAckEmitter.emit('job_failed', { jobRecord: updated, extra: { reason } });
    return { handled: true };
  }

  async function handleExecutionFailed({ envelope }) {
    const tokenUrn = envelope?.payload?.token_urn;
    const jobRecord = findJobByTokenUrn(jobLifecycle, tokenUrn);
    if (!jobRecord) return { handled: false, reason: 'not_our_token' };
    log('thalamus_execution_failed_rollforward', { job_urn: jobRecord.job_urn });
    try {
      if (jobRecord.state === 'DISPATCHED') await jobLifecycle.markExecuting(jobRecord.job_urn);
      await jobLifecycle.markFailed(jobRecord.job_urn, { error: 'cerberus_rollforward' });
    } catch (err) {
      log('thalamus_execution_failed_transition_failed', { error: err.message });
    }
    const updated = jobLifecycle.getJob(jobRecord.job_urn);
    await lifecycleAckEmitter.emit('job_failed', { jobRecord: updated, extra: { reason: 'cerberus_rollforward' } });
    return { handled: true };
  }

  return {
    dispatchWriteAfterAuth,
    dispatchR0,
    handleAdjudicationResult,
    handleAdjudicationHeld,
    handleApmRejected,
    handleExecutionCompleted,
    handleExecutionDenied,
    handleExecutionFailed,
    findJobByApRef: (apRef) => findJobByApRef(jobLifecycle, apRef),
    findJobByTokenUrn: (tokenUrn) => findJobByTokenUrn(jobLifecycle, tokenUrn),
  };
}
