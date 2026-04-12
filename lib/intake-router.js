/**
 * Intake router — dispatches inbound directed OTMs to the right intake handler
 * based on payload.event_type. Used by the Spine directed-message handler in
 * relay t3q-7. Kept as a small standalone module so it can be unit-tested
 * without booting Spine.
 *
 * Returns:
 *   - { handled: true,  job_urn }      — intake created a job
 *   - { handled: false, error }        — intake rejected the envelope
 *   - { handled: false, reason: 'unknown_event_type' } — event_type not an
 *     intake type. The Spine handler in t3q-7 logs this and silently absorbs
 *     (the envelope might be a Nomos/Cerberus message destined for the
 *     governance handlers, not the intake router).
 */

const INTAKE_EVENT_TYPES = new Set(['autonomous_goal', 'ingress_request']);

export function createIntakeRouter({ goalIntake, requestIntake }) {
  return async function routeIntake(envelope) {
    const eventType = envelope?.payload?.event_type;
    if (!INTAKE_EVENT_TYPES.has(eventType)) {
      return { handled: false, reason: 'unknown_event_type', event_type: eventType || null };
    }
    if (eventType === 'autonomous_goal') {
      return goalIntake(envelope);
    }
    return requestIntake(envelope);
  };
}

export { INTAKE_EVENT_TYPES };
