/**
 * Cerberus broadcast handler — routes execution_completed / execution_denied /
 * execution_failed broadcasts to the appropriate dispatcher handler.
 */

export function createCerberusBroadcastHandler({ dispatcher }) {
  return async function handleBroadcast(envelope) {
    if (envelope?.source_organ !== 'Cerberus') {
      return { handled: false, reason: 'not_from_cerberus' };
    }
    const eventType = envelope?.payload?.event_type;
    switch (eventType) {
      case 'execution_completed':
        return dispatcher.handleExecutionCompleted({ envelope });
      case 'execution_denied':
        return dispatcher.handleExecutionDenied({ envelope });
      case 'execution_failed':
        return dispatcher.handleExecutionFailed({ envelope });
      default:
        return { handled: false, reason: 'unknown_cerberus_event_type', event_type: eventType };
    }
  };
}
