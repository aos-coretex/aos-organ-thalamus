/**
 * Nomos ATM handler — directed-message handler for ATMs arriving from Nomos.
 * Looks up the job by ap_ref and calls the dispatcher's write path.
 */

export function createNomosAtmHandler({ dispatcher }) {
  return async function handleAtm(envelope) {
    if (envelope?.type !== 'ATM') {
      return { handled: false, reason: 'not_atm' };
    }
    if (envelope.source_organ !== 'Nomos') {
      return { handled: false, reason: 'wrong_source_organ' };
    }
    return dispatcher.dispatchWriteAfterAuth({ atmEnvelope: envelope });
  };
}
