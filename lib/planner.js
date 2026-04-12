/**
 * Post-intake planner — orchestrates the lane decision and dispatch path.
 *
 * Called immediately after an intake handler creates a JobRecord. Runs:
 *   1. PLANNING transition
 *   2. Lane Phase A heuristic
 *   3. If R0 -> derive targets and call dispatchR0
 *   4. If pending/write -> call apDrafter.draftAP
 *   5. Cleanup on any exception
 *
 * Best-effort wrapper — never throws. Any internal failure becomes a job
 * marked FAILED with the failure reason.
 */

function log(event, data = {}) {
  const entry = { timestamp: new Date().toISOString(), organ: 'Thalamus', event, ...data };
  process.stdout.write(JSON.stringify(entry) + '\n');
}

function deriveR0Targets(jobRecord) {
  const desc = (jobRecord.description || '').toLowerCase();
  const ic = jobRecord.intake_context || {};
  const intentLabel = (ic.intent_label || '').toLowerCase();

  if (desc.includes('report') || desc.includes('status')) return ['Vigil:status'];
  if (desc.includes('search') || desc.includes('find')) return ['Sourcegraph:search'];
  if (intentLabel === 'question') return ['Hippocampus:query', 'Radiant:query'];
  return ['Radiant:query']; // safe fallback
}

export function createPlanner({ jobLifecycle, laneSelector, apDrafter, dispatcher }) {
  async function safeFail(jobUrn, error) {
    try {
      const job = jobLifecycle.getJob(jobUrn);
      if (job && !['SUCCEEDED', 'DENIED', 'FAILED'].includes(job.state)) {
        // From PLANNING, the valid path to terminal is PLANNING -> DISPATCHED -> EXECUTING -> FAILED
        // or PLANNING -> AWAITING_AUTH -> DENIED. For safeFail from PLANNING, we go through
        // DISPATCHED -> EXECUTING -> FAILED to reach a terminal state.
        if (job.state === 'PLANNING') {
          await jobLifecycle.markDispatched(jobUrn, { target_organs: [] });
          await jobLifecycle.markExecuting(jobUrn);
          await jobLifecycle.markFailed(jobUrn, { error });
        } else if (job.state === 'DISPATCHED') {
          await jobLifecycle.markExecuting(jobUrn);
          await jobLifecycle.markFailed(jobUrn, { error });
        } else if (job.state === 'EXECUTING') {
          await jobLifecycle.markFailed(jobUrn, { error });
        } else if (job.state === 'AWAITING_AUTH') {
          await jobLifecycle.markDenied(jobUrn, { reason: error });
        }
      }
    } catch (err) {
      log('thalamus_planner_safefail_failed', { error: err.message, job_urn: jobUrn });
    }
  }

  async function planAndDispatch(jobRecord) {
    log('thalamus_planner_started', { job_urn: jobRecord.job_urn, source: jobRecord.source });

    // 1. PLANNING transition
    try {
      await jobLifecycle.markPlanning(jobRecord.job_urn);
    } catch (err) {
      log('thalamus_planner_planning_failed', { error: err.message, job_urn: jobRecord.job_urn });
      return { planned: false, error: err.message };
    }

    // 2. Lane Phase A heuristic
    const phaseA = laneSelector.selectLane(jobLifecycle.getJob(jobRecord.job_urn), { phase: 'preliminary' });
    log('thalamus_planner_phase_a', { job_urn: jobRecord.job_urn, lane: phaseA.lane, reasoning: phaseA.reasoning });

    // 3. R0 fast-path
    if (phaseA.lane === 'r0') {
      const targets = deriveR0Targets(jobLifecycle.getJob(jobRecord.job_urn));
      jobLifecycle.setLane(jobRecord.job_urn, 'r0');
      try {
        const result = await dispatcher.dispatchR0({ jobRecord: jobLifecycle.getJob(jobRecord.job_urn), targets });
        return { planned: true, lane: 'r0', dispatched: result.dispatched, completed: result.completed };
      } catch (err) {
        log('thalamus_planner_r0_dispatch_error', { error: err.message, job_urn: jobRecord.job_urn });
        await safeFail(jobRecord.job_urn, `r0_dispatch_error: ${err.message}`);
        return { planned: false, error: err.message };
      }
    }

    // 4. Write-lane / pending -> draft AP
    let draftResult;
    try {
      const j = jobLifecycle.getJob(jobRecord.job_urn);
      draftResult = await apDrafter.draftAP(j);
    } catch (err) {
      log('thalamus_planner_drafter_threw', { error: err.message, job_urn: jobRecord.job_urn });
      await safeFail(jobRecord.job_urn, `drafter_exception: ${err.message}`);
      return { planned: false, error: err.message };
    }

    if (!draftResult.submitted) {
      const r0Reroute = (draftResult.degraded || []).find(d => d.startsWith('ap-drafter-r0-targets'));
      if (r0Reroute) {
        log('thalamus_planner_r0_reroute', { job_urn: jobRecord.job_urn, reason: r0Reroute });
        const j = jobLifecycle.getJob(jobRecord.job_urn);
        const fallbackTargets = deriveR0Targets(j);
        jobLifecycle.setLane(jobRecord.job_urn, 'r0');
        try {
          const r0Result = await dispatcher.dispatchR0({ jobRecord: jobLifecycle.getJob(jobRecord.job_urn), targets: fallbackTargets });
          return { planned: true, lane: 'r0', rerouted_from_drafter: true, dispatched: r0Result.dispatched };
        } catch (err) {
          await safeFail(jobRecord.job_urn, `r0_reroute_failed: ${err.message}`);
          return { planned: false, error: err.message };
        }
      }

      log('thalamus_planner_drafter_declined', { job_urn: jobRecord.job_urn, degraded: draftResult.degraded });
      await safeFail(jobRecord.job_urn, `drafter_declined: ${(draftResult.degraded || []).join(',')}`);
      return { planned: false, error: 'drafter_declined', degraded: draftResult.degraded };
    }

    // 5. APM on the wire to Nomos. Job is in AWAITING_AUTH.
    log('thalamus_planner_apm_submitted', {
      job_urn: jobRecord.job_urn,
      ap_ref: draftResult.ap_ref,
      risk_tier: draftResult.risk_tier,
    });
    return { planned: true, lane: 'write', submitted: true, ap_ref: draftResult.ap_ref };
  }

  return { planAndDispatch, deriveR0Targets };
}
