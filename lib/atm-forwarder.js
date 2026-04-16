/**
 * ATM forwarder — receives a Nomos ATM, enriches the payload with
 * execution_request rehydrated from the JobRecord, rewrites source_organ
 * to 'Thalamus' (Cerberus's defence-in-depth check requires this), and
 * dispatches via spine.send.
 *
 * Critical contract (verified against AOS-organ-cerberus-src/handlers/atm-handler.js):
 *   - source_organ MUST equal 'Thalamus' or Cerberus rejects
 *   - payload.execution_request MUST be present
 *   - execution_request MUST contain { targets, action_type, credential_name }
 *
 * The forwarded ATM keeps the original token_urn, scope, ap_ref, ruling_ref —
 * those are the authorization material Cerberus's token-validator runs against.
 * Thalamus does NOT touch them.
 */

function log(event, data = {}) {
  const entry = { timestamp: new Date().toISOString(), organ: 'Thalamus', event, ...data };
  process.stdout.write(JSON.stringify(entry) + '\n');
}

export function createAtmForwarder({ spine, jobLifecycle }) {
  async function forwardAtm({ jobRecord, atmEnvelope }) {
    if (!jobRecord) {
      log('thalamus_atm_forward_no_job', { ap_ref: atmEnvelope?.payload?.ap_ref });
      return { forwarded: false, error: 'job_not_found_for_ap_ref' };
    }

    if (!jobRecord.execution_plan) {
      log('thalamus_atm_forward_no_execution_plan', { job_urn: jobRecord.job_urn });
      return { forwarded: false, error: 'execution_plan_missing' };
    }

    // MP-17 relay g7c-6 — tenant_urn required in execution_request per
    // Cerberus g7c-5 contract (gate 7b TOKEN_MISSING_EXECUTION_CONTEXT).
    // The JobRecord.tenant_urn was set at intake and must be present by
    // the time we reach ATM forward. Fail structured — do NOT pass-through
    // a tenant-less ATM. Per g7c-5 RFI-1 Option B discipline: the denial
    // must be attributable to Thalamus's intake side (tenant_urn should
    // have been captured on the JobRecord at creation), not lost inside
    // Cerberus's denial taxonomy.
    if (!jobRecord.tenant_urn) {
      log('thalamus_atm_forward_no_tenant_urn', {
        job_urn: jobRecord.job_urn,
        ap_ref: atmEnvelope.payload.ap_ref,
        note: 'JobRecord lacks tenant_urn — intake-side failure, fix at intake not here',
      });
      return { forwarded: false, error: 'tenant_urn_missing_on_job_record' };
    }

    const ep = jobRecord.execution_plan;

    const enriched = {
      type: 'ATM',
      source_organ: 'Thalamus',
      target_organ: 'Cerberus',
      reply_to: 'Thalamus',
      payload: {
        token_urn:    atmEnvelope.payload.token_urn,
        scope:        atmEnvelope.payload.scope,
        ap_ref:       atmEnvelope.payload.ap_ref,
        ruling_ref:   atmEnvelope.payload.ruling_ref,
        execution_request: {
          targets:         ep.targets,
          action_type:     ep.action_type,
          credential_name: ep.credential_name,
          conditionState:  ep.conditionState || {},
          payload:         ep.payload || {},
          // MP-17 relay g7c-6 — executing-entity context (Cerberus g7c-5 gate 7b/7c)
          tenant_urn:      jobRecord.tenant_urn,
        },
        job_reference: jobRecord.job_urn,
      },
    };

    let sendResult;
    try {
      sendResult = await spine.send(enriched);
    } catch (err) {
      log('thalamus_atm_forward_send_failed', {
        job_urn: jobRecord.job_urn,
        ap_ref: atmEnvelope.payload.ap_ref,
        error: err.message,
      });
      return { forwarded: false, error: `spine_send_failed: ${err.message}` };
    }

    log('thalamus_atm_forwarded', {
      job_urn: jobRecord.job_urn,
      ap_ref: atmEnvelope.payload.ap_ref,
      token_urn: atmEnvelope.payload.token_urn,
      action_type: ep.action_type,
      target_count: ep.targets.length,
      forwarded_message_id: sendResult?.message_id,
    });

    try {
      await jobLifecycle.markDispatched(jobRecord.job_urn, {
        token_urn: atmEnvelope.payload.token_urn,
        target_organs: ['Cerberus'],
      });
    } catch (err) {
      log('thalamus_atm_forward_post_send_transition_failed', {
        job_urn: jobRecord.job_urn,
        error: err.message,
      });
      return {
        forwarded: true,
        target: 'Cerberus',
        execution_request_attached: true,
        forwarded_message_id: sendResult?.message_id,
        post_send_transition_error: err.message,
      };
    }

    return {
      forwarded: true,
      target: 'Cerberus',
      execution_request_attached: true,
      forwarded_message_id: sendResult?.message_id,
    };
  }

  return { forwardAtm };
}
