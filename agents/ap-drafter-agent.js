/**
 * Thalamus AP Drafter Agent — Sonnet system prompt + prompt builder + response parser.
 *
 * BINDING (per the 2026-04-11 amendment to MP-13 — Cortex role audit Finding 1
 * resolution): this file MUST NOT contain any scope-ruling language. The
 * forbidden phrase list (case-insensitive):
 *
 *   in_scope, out_of_scope, ambiguous, scope ruling, scope check, scope gate,
 *   permitted action, forbidden action
 *
 * Plus the uppercase variants (IN_SCOPE, OUT_OF_SCOPE, AMBIGUOUS).
 *
 * The CV test cv-scope-ruling-prompt-discipline (relay t3q-8) enforces this
 * mechanically — same 3-layer pattern as Cortex's
 * cv-scope-ruling-prompt-discipline.test.js:
 *   1. Import SYSTEM_PROMPT and grep
 *   2. Read this file from disk and grep
 *   3. Run buildPrompt() with a sample missionFrame and grep the output
 *
 * Why: Thalamus reads MSP+BoR for constitutional CONDITIONING — for thinking
 * inside the organism's mission and rights. Determinations on the perimeter
 * belong to Arbiter, not the drafter. If the drafter starts making such
 * determinations, Thalamus has stepped on Arbiter's authority and the
 * dual-organ separation collapses. The mechanical guard prevents drift.
 *
 * The drafter's job is: given a goal/request, given the constitutional frame,
 * given evidence, given graph context, COMPOSE an Action Proposal envelope.
 * That's it. The AP then goes to Nomos, which routes it to Arbiter for the
 * actual adjudication.
 */

export const SYSTEM_PROMPT = `You are the Action Proposal drafter for Thalamus, the operational coordination organ of a Distributed Intelligence Organism (DIO).

Your role: given a goal or request, given the organism's mission and constitutional identity, given gathered evidence and structural context, compose a structured Action Proposal that describes HOW the work should be performed.

You answer: "Given this goal and this constitutional identity, what concrete action should be proposed, with what evidence, with what risk, with what rollback plan?"

You do NOT answer: "Is this allowed?" — Such determinations are made by Arbiter at the adjudication step that follows your draft. Your job is to draft a clear, well-evidenced proposal; downstream organs decide whether to authorize it.

You receive four inputs:
1. The mission and constitutional identity (Mission Statement Protocol + Bill of Rights raw text). Use these to frame your draft within the organism's purpose. They are your conditioning context — read them to understand what the organism is trying to be.
2. The goal or request being processed (description, target state, priority, originator context).
3. Gathered evidence from Collective Memory (Radiant context, Minder observations, Hippocampus conversation, Syntra semantic results).
4. Structural context from Graph (entities and bindings touched by the proposed action).

You produce a single JSON object with this exact shape:

{
  "action": "string — one-line description of what will be done",
  "reason": "string — why this action achieves the goal, grounded in mission + evidence",
  "targets": ["organ:action", ...],
  "risk_tier": "low | medium | high | critical",
  "rollback_plan": "string — how to undo this action if it fails or is wrong",
  "execution_plan": {
    "targets": ["resource_urn", ...],
    "action_type": "string — e.g. graph_concept_upsert, engram_ingest, radiant_promote",
    "credential_name": "string — Cerberus credential registry name, e.g. coretex.cerberus.graph_writer",
    "conditionState": { "<condition_name>": true },
    "payload": { /* opaque JSON payload the executor needs */ }
  },
  "evidence_refs": ["urn:...", ...]
}

Rules:
- targets uses "organ:action" syntax (e.g. "Engram:ingest", "Radiant:promote", "Graph:upsert"). The lane selector reads this list to decide R0 vs write.
- risk_tier defaults to medium when uncertain. Higher tiers receive shorter token TTLs from the authorizer.
- rollback_plan must always be present. If rollback is genuinely impossible, write "irreversible — see escalation note" and set risk_tier to high or critical.
- execution_plan.targets are the concrete resource URNs the action affects, not "organ:action" tags.
- execution_plan.action_type must match a registered Cerberus action_type (currently: graph_concept_upsert; the registry will grow).
- execution_plan.credential_name must match a Cerberus credential registry entry.
- execution_plan.payload is the data the executor needs (e.g. the concept JSON for graph_concept_upsert).
- evidence_refs cites the URNs from your evidence input that ground your proposal.

Output ONLY the JSON object. No prose before or after.`;

/**
 * Build the user-content portion of the prompt. Composes the mission frame,
 * the job's goal/request, the gathered evidence, and any graph context into
 * a single structured message.
 */
export function buildPrompt({ jobRecord, missionFrame, evidence, graphContext }) {
  const mspBlock = missionFrame?.msp?.raw_text
    ? `\n# Mission Statement Protocol (active)\nVersion: ${missionFrame.msp.version}\nHash: ${missionFrame.msp.hash}\n\n${missionFrame.msp.raw_text}\n`
    : '\n# Mission Statement Protocol\n[NOT AVAILABLE — degraded constitutional context]\n';

  const borBlock = missionFrame?.bor?.raw_text
    ? `\n# Bill of Rights (active)\nVersion: ${missionFrame.bor.version}\nHash: ${missionFrame.bor.hash}\n\n${missionFrame.bor.raw_text}\n`
    : '\n# Bill of Rights\n[NOT AVAILABLE — degraded constitutional context]\n';

  const goalBlock = jobRecord.source === 'cortex'
    ? `\n# Cortex-originated goal\nDescription: ${jobRecord.description}\nTarget state: ${jobRecord.intake_context?.target_state || '[unspecified]'}\nPriority: ${jobRecord.priority}\nMission ref: ${jobRecord.mission_ref || '[none]'}\nSeverity: ${jobRecord.intake_context?.severity ?? '[unspecified]'}\nSource category: ${jobRecord.intake_context?.source_category || '[unspecified]'}\nSuggested approach (from Cortex): ${jobRecord.intake_context?.suggested_approach || '[none]'}\n`
    : `\n# Receptor-originated request\nIntent: ${jobRecord.intake_context?.intent_label || '[unknown]'}\nUser identity: ${jobRecord.intake_context?.user_identity || '[unknown]'}\nChannel: ${jobRecord.intake_context?.channel || '[unknown]'}\nMessage: ${JSON.stringify(jobRecord.intake_context?.message || null).slice(0, 500)}\nClassification confidence: ${jobRecord.intake_context?.classification_confidence ?? '[unspecified]'}\n`;

  const evidenceBlock = evidence?.length
    ? `\n# Evidence gathered from Collective Memory\n${evidence.map((e, i) => `[${i + 1}] (${e.source}${e.urn ? ' / ' + e.urn : ''}) ${e.content}`).join('\n')}\n`
    : '\n# Evidence gathered from Collective Memory\n[NONE — proceed with caution]\n';

  const graphBlock = graphContext && (graphContext.entities?.length || graphContext.bindings?.length)
    ? `\n# Structural context from Graph\nEntities (${graphContext.entities?.length || 0}):\n${(graphContext.entities || []).slice(0, 10).map(e => `  - ${e.urn}: ${JSON.stringify(e.data || {}).slice(0, 200)}`).join('\n')}\nBindings (${graphContext.bindings?.length || 0}):\n${(graphContext.bindings || []).slice(0, 10).map(b => `  - ${b.urn}`).join('\n')}\n`
    : '\n# Structural context from Graph\n[NONE]\n';

  return `${mspBlock}${borBlock}${goalBlock}${evidenceBlock}${graphBlock}\n\nDraft the Action Proposal now. Output ONLY the JSON object.`;
}

/**
 * Parse the Sonnet response into a structured AP. Returns
 *   { ap: { action, reason, targets, risk_tier, rollback_plan, execution_plan, evidence_refs }, error: null }
 * or { ap: null, error: "string" } on parse failure.
 */
export function parseResponse(content) {
  if (!content) return { ap: null, error: 'empty_response' };

  // Strip markdown fences if the model wrapped the JSON
  let cleaned = content.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```[a-z]*\n?/i, '').replace(/```$/, '').trim();
  }

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    return { ap: null, error: `json_parse_error: ${err.message}` };
  }

  // Required field validation
  const required = ['action', 'reason', 'targets', 'risk_tier', 'rollback_plan', 'execution_plan'];
  for (const field of required) {
    if (parsed[field] === undefined || parsed[field] === null) {
      return { ap: null, error: `missing_field: ${field}` };
    }
  }
  if (!Array.isArray(parsed.targets)) {
    return { ap: null, error: 'targets_not_array' };
  }
  const validRiskTiers = ['low', 'medium', 'high', 'critical'];
  if (!validRiskTiers.includes(parsed.risk_tier)) {
    return { ap: null, error: `invalid_risk_tier: ${parsed.risk_tier}` };
  }
  if (typeof parsed.execution_plan !== 'object') {
    return { ap: null, error: 'execution_plan_not_object' };
  }
  const planRequired = ['targets', 'action_type', 'credential_name'];
  for (const field of planRequired) {
    if (parsed.execution_plan[field] === undefined || parsed.execution_plan[field] === null) {
      return { ap: null, error: `missing_execution_plan_field: ${field}` };
    }
  }
  if (!Array.isArray(parsed.execution_plan.targets)) {
    return { ap: null, error: 'execution_plan_targets_not_array' };
  }

  return {
    ap: {
      action:         parsed.action,
      reason:         parsed.reason,
      targets:        parsed.targets,
      risk_tier:      parsed.risk_tier,
      rollback_plan:  parsed.rollback_plan,
      execution_plan: {
        targets:         parsed.execution_plan.targets,
        action_type:     parsed.execution_plan.action_type,
        credential_name: parsed.execution_plan.credential_name,
        conditionState:  parsed.execution_plan.conditionState || {},
        payload:         parsed.execution_plan.payload || {},
      },
      evidence_refs:  Array.isArray(parsed.evidence_refs) ? parsed.evidence_refs : [],
    },
    error: null,
  };
}
