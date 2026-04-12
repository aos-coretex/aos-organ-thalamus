/**
 * Request intake — consumes Receptor `ingress_request` OTMs.
 *
 * Receptor envelope shape (per 01-Organs/250-Receptor/receptor-organ-definition.md S5):
 *   envelope.type === 'OTM'
 *   envelope.source_organ === 'Receptor'
 *   envelope.target_organ === 'Thalamus'
 *   envelope.payload.event_type === 'ingress_request'
 *   envelope.payload.payload_urn   (Graphheight URN)
 *   envelope.payload.intent_urn    (Graphheight URN)
 *   envelope.payload.intent_label  (string)
 *   envelope.payload.channel       (string)
 *   envelope.payload.session_id    (string)
 *   envelope.payload.user_identity (URN)
 *   envelope.payload.message       (object)
 *   envelope.payload.classification_confidence (number)
 *
 * Receptor does not carry an explicit priority field. Priority is derived
 * from intent_label via a small inline lookup. Description is intent_label
 * plus a truncated message summary.
 *
 * Same malformed-envelope semantics, same job_record_created ack pattern.
 */

const RECEPTOR_INTENT_PRIORITY = {
  emergency: 'critical',
  urgent: 'high',
  question: 'medium',
  request: 'medium',
  feedback: 'low',
  notification: 'low',
};

const VALID_PRIORITIES = ['low', 'medium', 'high', 'critical'];

function log(event, data = {}) {
  const entry = { timestamp: new Date().toISOString(), organ: 'Thalamus', event, ...data };
  process.stdout.write(JSON.stringify(entry) + '\n');
}

function summarizeMessage(msg) {
  if (!msg) return '';
  if (typeof msg === 'string') return msg.slice(0, 200);
  try {
    return JSON.stringify(msg).slice(0, 200);
  } catch {
    return '[unserializable message]';
  }
}

export function createRequestIntake({ jobLifecycle, lifecycleAckEmitter }) {
  async function handleRequestEnvelope(envelope) {
    if (!envelope?.payload) {
      log('thalamus_request_intake_rejected', { reason: 'malformed_envelope' });
      return { handled: false, error: 'malformed_envelope' };
    }
    if (envelope.source_organ !== 'Receptor') {
      log('thalamus_request_intake_rejected', { reason: 'wrong_source_organ', source_organ: envelope.source_organ });
      return { handled: false, error: 'wrong_source_organ' };
    }
    if (envelope.payload.event_type !== 'ingress_request') {
      log('thalamus_request_intake_rejected', { reason: 'wrong_event_type', event_type: envelope.payload.event_type });
      return { handled: false, error: 'wrong_event_type' };
    }

    const p = envelope.payload;

    if (typeof p.payload_urn !== 'string') {
      log('thalamus_request_intake_rejected', { reason: 'missing_payload_urn' });
      return { handled: false, error: 'missing_payload_urn' };
    }
    if (typeof p.intent_label !== 'string') {
      log('thalamus_request_intake_rejected', { reason: 'missing_intent_label' });
      return { handled: false, error: 'missing_intent_label' };
    }

    const intentKey = (p.intent_label || '').toLowerCase();
    let priority = RECEPTOR_INTENT_PRIORITY[intentKey] || 'medium';
    if (!VALID_PRIORITIES.includes(priority)) priority = 'medium';

    const description = `${p.intent_label}: ${summarizeMessage(p.message)}`.slice(0, 240);

    let jobRecord;
    try {
      jobRecord = await jobLifecycle.createJob({
        source: 'receptor',
        originator_ref: envelope.message_id,
        reply_to: envelope.reply_to || envelope.source_organ || 'Receptor',
        priority,
        description,
      });
    } catch (err) {
      log('thalamus_request_intake_create_failed', { error: err.message, payload_urn: p.payload_urn });
      return { handled: false, error: `job_create_failed: ${err.message}` };
    }

    jobLifecycle.enrichIntakeContext(jobRecord.job_urn, {
      mission_ref: null,
      evidence_refs: [],
      assessment_context: null,
      intake_context: {
        kind: 'receptor_request',
        payload_urn: p.payload_urn,
        intent_urn: p.intent_urn,
        intent_label: p.intent_label,
        channel: p.channel,
        session_id: p.session_id,
        user_identity: p.user_identity,
        classification_confidence: p.classification_confidence,
        message: p.message,
      },
    });

    log('thalamus_request_intake_accepted', {
      job_urn: jobRecord.job_urn,
      intent_label: p.intent_label,
      channel: p.channel,
      priority,
    });

    const updated = jobLifecycle.getJob(jobRecord.job_urn);
    await lifecycleAckEmitter.emit('job_record_created', { jobRecord: updated });

    return { handled: true, job_urn: jobRecord.job_urn };
  }

  return handleRequestEnvelope;
}
