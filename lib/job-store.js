/**
 * In-memory JobRecord cache.
 *
 * Mirrors spine-state for fast `/jobs/:id` HTTP reads. NOT persistent — the
 * authoritative store is spine-state. The cache is rehydrated from spine-state
 * on boot via listNonTerminalJobs() (currently a no-op — see spine-state-client
 * TODO). New jobs created during a session populate the cache automatically.
 *
 * JobRecord shape:
 *   {
 *     job_urn:           "urn:llm-ops:job:<ts>-<rand>",
 *     source:            "cortex" | "receptor" | "internal",
 *     originator_ref:    "<message_id of the goal/request OTM>",
 *     reply_to:          "<organ name to send lifecycle acks>",
 *     priority:          "low" | "medium" | "high" | "critical",
 *     description:       "<short description from goal/request>",
 *     state:             "<spine-state machine state>",
 *     lane:              "pending" | "r0" | "write",
 *     created_at:        ISO8601,
 *     updated_at:        ISO8601,
 *
 *     // Set during PLANNING (relay t3q-3 / t3q-4 / t3q-5)
 *     mission_frame_ref: "<mission_frame_id used for AP drafting>",
 *     evidence_refs:     ["<urn>", ...],
 *     graph_context:     { entities: [], bindings: [] } | null,
 *     risk_tier:         "low" | "medium" | "high" | "critical" | null,
 *     rollback_plan:     "<text>" | null,
 *     targets:           ["<organ>:<action>", ...],
 *     execution_plan:    {
 *       // What Cerberus needs in payload.execution_request when ATM lands.
 *       // Persisted at AP-draft time, rehydrated at ATM-forward time.
 *       targets:         ["<resource_urn>", ...],
 *       action_type:     "<e.g. graph_concept_upsert>",
 *       credential_name: "<e.g. coretex.cerberus.graph_writer>",
 *       conditionState:  { "<condition_name>": true, ... },
 *       payload:         { ... }
 *     } | null,
 *
 *     // Set when AP is sent (relay t3q-3) -> AWAITING_AUTH
 *     ap_ref:            "<APM message_id>" | null,
 *
 *     // Set when ATM arrives (relay t3q-6) -> DISPATCHED
 *     token_urn:         "<authorization token URN>" | null,
 *
 *     // Set when execution lands (relay t3q-6) -> SUCCEEDED / FAILED / DENIED
 *     execution_id:      "<from Cerberus execution_completed broadcast>" | null,
 *     result:            { ... } | null,
 *     denial_reason:     "<from Nomos>" | null,
 *     error:             "<error message>" | null,
 *
 *     // Intake enrichment (set by enrichIntakeContext in relay t3q-2)
 *     mission_ref:       "<MSP section reference from Cortex>" | null,
 *     assessment_context: { msp_version, msp_hash, bor_version, bor_hash, assessed_at, cortex_iteration } | null,
 *     intake_context:    { kind: "cortex_goal" | "receptor_request", ...intake-specific fields } | null,
 *   }
 */

export function createJobStore({ limit = 1000 } = {}) {
  const jobs = new Map(); // job_urn -> JobRecord
  const insertionOrder = []; // for FIFO eviction when limit exceeded

  function add(jobRecord) {
    if (!jobRecord?.job_urn) {
      throw new Error('job_record_missing_urn');
    }
    if (jobs.has(jobRecord.job_urn)) {
      throw new Error(`job_already_exists: ${jobRecord.job_urn}`);
    }
    jobs.set(jobRecord.job_urn, jobRecord);
    insertionOrder.push(jobRecord.job_urn);

    // FIFO eviction — only terminal jobs are evicted; non-terminal jobs stay
    // until they reach a terminal state, then become eligible.
    while (insertionOrder.length > limit) {
      const oldest = insertionOrder[0];
      const oldestRec = jobs.get(oldest);
      if (oldestRec && ['SUCCEEDED', 'DENIED', 'FAILED'].includes(oldestRec.state)) {
        insertionOrder.shift();
        jobs.delete(oldest);
      } else {
        break; // can't evict non-terminal — wait until it terminates
      }
    }
  }

  function update(jobUrn, patch) {
    const existing = jobs.get(jobUrn);
    if (!existing) throw new Error(`job_not_found: ${jobUrn}`);
    const next = { ...existing, ...patch, updated_at: new Date().toISOString() };
    jobs.set(jobUrn, next);
    return next;
  }

  function get(jobUrn) {
    return jobs.get(jobUrn) || null;
  }

  function list({ status = null, source = null, limit: queryLimit = 100 } = {}) {
    let result = Array.from(jobs.values());
    if (status) result = result.filter(j => j.state === status);
    if (source) result = result.filter(j => j.source === source);
    return result.slice(-queryLimit).reverse(); // most recent first
  }

  function size() {
    return jobs.size;
  }

  function clear() {
    jobs.clear();
    insertionOrder.length = 0;
  }

  function stats() {
    const counts = { CREATED: 0, PLANNING: 0, AWAITING_AUTH: 0, DISPATCHED: 0, EXECUTING: 0, SUCCEEDED: 0, DENIED: 0, FAILED: 0 };
    for (const j of jobs.values()) {
      if (counts[j.state] !== undefined) counts[j.state] += 1;
    }
    return { total: jobs.size, by_state: counts };
  }

  return { add, update, get, list, size, clear, stats };
}
