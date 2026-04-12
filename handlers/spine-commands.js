/**
 * Directed message handler for Thalamus.
 *
 * Routes inbound directed messages to the appropriate processor:
 *   - OTM with intake event_type -> intake-router -> planner.planAndDispatch
 *   - OTM adjudication_result / adjudication_held / apm_rejected -> dispatcher
 *   - OTM health_check -> return health summary
 *   - ATM -> nomos-atm handler -> dispatcher.dispatchWriteAfterAuth
 *   - APM / PEM / HOM -> reject (Thalamus does not consume these)
 *   - Unknown OTM event_type -> log and return null (silent absorb)
 *
 * After successful intake, the handler kicks off planAndDispatch ASYNCHRONOUSLY
 * (fire-and-forget). The Spine reply does not wait for planning to complete.
 */

import { INTAKE_EVENT_TYPES } from '../lib/intake-router.js';

function log(event, data = {}) {
  const entry = { timestamp: new Date().toISOString(), organ: 'Thalamus', event, ...data };
  process.stdout.write(JSON.stringify(entry) + '\n');
}

const NON_CONSUMER_TYPES = new Set(['APM', 'PEM', 'HOM']);

export function createDirectedHandler({ intakeRouter, planner, dispatcher, nomosAtmHandler, jobLifecycle }) {
  return async function handleDirected(envelope) {
    const envelopeType = envelope?.type;
    const eventType = envelope?.payload?.event_type;

    // ATM path
    if (envelopeType === 'ATM') {
      log('thalamus_directed_atm', { source: envelope?.source_organ, message_id: envelope?.message_id });
      return nomosAtmHandler(envelope);
    }

    // Reject APM / PEM / HOM — Thalamus is not a consumer
    if (NON_CONSUMER_TYPES.has(envelopeType)) {
      log('thalamus_non_consumer_message_rejected', { type: envelopeType, source: envelope?.source_organ });
      return { handled: false, error: 'thalamus_does_not_consume_this_type', type: envelopeType };
    }

    // OTM only beyond this point
    if (envelopeType !== 'OTM') {
      log('thalamus_unknown_envelope_type', { type: envelopeType });
      return { handled: false, error: 'unknown_envelope_type' };
    }

    // OTM intake (Cortex goal or Receptor request)
    if (INTAKE_EVENT_TYPES.has(eventType)) {
      const result = await intakeRouter(envelope);
      if (result.handled && result.job_urn) {
        // Fire-and-forget planning
        const job = jobLifecycle.getJob(result.job_urn);
        if (job) {
          planner.planAndDispatch(job).catch((err) => {
            log('thalamus_planner_async_failure', { error: err.message, job_urn: result.job_urn });
          });
        }
      }
      return result;
    }

    // OTM Nomos responses
    if (eventType === 'adjudication_result') return dispatcher.handleAdjudicationResult({ envelope });
    if (eventType === 'adjudication_held')   return dispatcher.handleAdjudicationHeld({ envelope });
    if (eventType === 'apm_rejected')        return dispatcher.handleApmRejected({ envelope });

    // OTM health check
    if (eventType === 'health_check') {
      return {
        type: 'OTM',
        source_organ: 'Thalamus',
        target_organ: envelope.source_organ,
        payload: { event_type: 'health_response', status: 'ok' },
      };
    }

    // Unknown OTM — silent absorb
    log('thalamus_unknown_directed_event_type', { event_type: eventType, source: envelope?.source_organ });
    return null;
  };
}
