/**
 * Broadcast handler for Thalamus.
 *
 * Subscribes to:
 *   - msp_updated, bor_updated, governance_version_activated -> invalidate mission cache
 *   - execution_completed, execution_denied, execution_failed -> cerberus-broadcast handler
 *   - state_transition -> silent observability
 *   - mailbox_pressure -> silent (no Thalamus action for MP-13)
 *   - everything else -> silent
 */

function log(event, data = {}) {
  const entry = { timestamp: new Date().toISOString(), organ: 'Thalamus', event, ...data };
  process.stdout.write(JSON.stringify(entry) + '\n');
}

export function createBroadcastHandler({ missionLoader, cerberusBroadcastHandler }) {
  return async function handleBroadcast(envelope) {
    const eventType = envelope?.payload?.event_type;

    if (eventType === 'msp_updated' || eventType === 'bor_updated' || eventType === 'governance_version_activated') {
      log('thalamus_mission_invalidated_by_broadcast', { event_type: eventType });
      missionLoader.invalidate(eventType);
      return;
    }

    if (eventType === 'execution_completed' || eventType === 'execution_denied' || eventType === 'execution_failed') {
      return cerberusBroadcastHandler(envelope);
    }

    // state_transition, mailbox_pressure, unknown — silent
    return;
  };
}
