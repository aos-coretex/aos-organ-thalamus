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
