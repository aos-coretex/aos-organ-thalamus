/**
 * Lifecycle ack emitter — directed OTM dispatch to the originator of a job.
 *
 * Used by intake handlers (relay t3q-2) and the dispatcher (relay t3q-6) to
 * notify Cortex/Receptor of the 4 lifecycle milestones:
 *   - job_record_created  (this relay — emitted by intake handlers)
 *   - job_dispatched      (relay t3q-6 — emitted after ATM forwarded / R0 dispatch)
 *   - job_completed       (relay t3q-6 — emitted on SUCCEEDED)
 *   - job_failed          (relay t3q-6 — emitted on FAILED or DENIED)
 *
 * The emitter is best-effort. Spine send failures are logged but do not throw —
 * the intake / dispatch path must not fail because of an observability hiccup.
 *
 * Cortex consumes all 4 (verified in AOS-organ-cortex-src/handlers/spine-commands.js).
 * Receptor will consume the same set when MP-14 lands. Until then, Receptor
 * silently drops them — Spine will queue them in the Receptor mailbox with
 * normal OTM TTL and they will be drained as soon as Receptor boots.
 *
 * Pre-mint discipline: matches Cortex's goal-emitter — message_id and
 * timestamp are NOT pre-set. Spine assigns them at POST /messages time.
 */

function log(event, data = {}) {
  const entry = { timestamp: new Date().toISOString(), organ: 'Thalamus', event, ...data };
  process.stdout.write(JSON.stringify(entry) + '\n');
}

const LIFECYCLE_EVENT_TYPES = ['job_record_created', 'job_dispatched', 'job_completed', 'job_failed'];

export function createLifecycleAckEmitter({ spine }) {
  async function emit(eventType, { jobRecord, extra = {} }) {
    if (!LIFECYCLE_EVENT_TYPES.includes(eventType)) {
      log('thalamus_lifecycle_ack_invalid_type', { event_type: eventType });
      return { dispatched: false, reason: 'invalid_event_type' };
    }
    if (!jobRecord?.reply_to) {
      log('thalamus_lifecycle_ack_skipped_no_reply_to', { job_urn: jobRecord?.job_urn, event_type: eventType });
      return { dispatched: false, reason: 'no_reply_to' };
    }

    const envelope = {
      type: 'OTM',
      source_organ: 'Thalamus',
      target_organ: jobRecord.reply_to,
      payload: {
        event_type: eventType,
        job_id: jobRecord.job_urn,
        originator_ref: jobRecord.originator_ref,
        state: jobRecord.state,
        lane: jobRecord.lane,
        ...extra,
      },
      // message_id and timestamp assigned by Spine
    };

    try {
      await spine.send(envelope);
      log('thalamus_lifecycle_ack_emitted', {
        event_type: eventType,
        job_urn: jobRecord.job_urn,
        target: jobRecord.reply_to,
      });
      return { dispatched: true };
    } catch (err) {
      log('thalamus_lifecycle_ack_dispatch_failed', {
        event_type: eventType,
        job_urn: jobRecord.job_urn,
        error: err.message,
      });
      return { dispatched: false, reason: 'spine_send_failed', error: err.message };
    }
  }

  return { emit, LIFECYCLE_EVENT_TYPES };
}
