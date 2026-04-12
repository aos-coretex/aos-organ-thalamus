/**
 * AP Drafter — high-level orchestrator that:
 *   1. Loads the mission frame (MSP + BoR raw text)
 *   2. Gathers evidence from Collective Memory
 *   3. (Stubbed for t3q-3) calls graph-context for structural enrichment — relay t3q-5 fills this in
 *   4. Calls the Sonnet drafter agent
 *   5. Composes the APM envelope (no pre-minted message_id)
 *   6. Submits via spine.send and captures the assigned ap_ref
 *   7. Transitions the job to AWAITING_AUTH with all enrichment
 *
 * Fail-closed posture: any failure in steps 1-6 produces { submitted: false,
 * degraded: [...] } and leaves the job in PLANNING. The caller (the planner
 * in relay t3q-7) decides whether to retry or mark FAILED.
 *
 * The drafter never throws (defensive try/catch around the LLM call) — it
 * always returns a structured result. Throwing would crash the inbound Spine
 * message handler, which is worse than emitting a degraded result.
 */

import { createLLMClient } from '@coretex/organ-boot/llm-client';
import { SYSTEM_PROMPT, buildPrompt, parseResponse } from '../agents/ap-drafter-agent.js';

function log(event, data = {}) {
  const entry = { timestamp: new Date().toISOString(), organ: 'Thalamus', event, ...data };
  process.stdout.write(JSON.stringify(entry) + '\n');
}

/**
 * @param {object} config
 * @param {object} config.llmConfig         - { agentName, defaultModel, defaultProvider, apiKeyEnvVar, maxTokens }
 * @param {object} [config.injectedLlm]     - optional LLM stub for tests
 * @param {object} config.missionLoader     - createMissionLoader instance (loadMission, invalidate, peekCache)
 * @param {object} config.cmEvidenceClient  - createCmEvidenceClient instance (gather)
 * @param {object} [config.graphContext]    - createGraphContext instance — t3q-5 wires this; t3q-3 may pass a noop
 * @param {object} config.spine             - spine client / spineProxy (provides send())
 * @param {object} config.jobLifecycle      - createJobLifecycle (markAwaitingAuth)
 * @returns {{ draftAP: (jobRecord) => Promise<{ submitted, ap_ref?, risk_tier?, execution_plan?, degraded }> }}
 */
export function createAPDrafter(config) {
  const { llmConfig, injectedLlm, missionLoader, cmEvidenceClient, graphContext, spine, jobLifecycle, laneSelector } = config;
  const llm = injectedLlm || createLLMClient(llmConfig);

  async function draftAP(jobRecord) {
    const degraded = [];

    // --- Step 1: Load mission frame ---
    let missionFrame;
    try {
      missionFrame = await missionLoader.loadMission();
      if (missionFrame.degraded?.length) degraded.push(...missionFrame.degraded.map(d => `mission:${d}`));
    } catch (err) {
      log('thalamus_drafter_mission_load_error', { error: err.message, job_urn: jobRecord.job_urn });
      return { submitted: false, degraded: ['mission-load-error'] };
    }

    // Fail-closed if both MSP and BoR are absent — no constitutional conditioning at all
    const missionAbsent = !missionFrame.msp && !missionFrame.bor;
    if (missionAbsent) {
      log('thalamus_drafter_skipped_mission_absent', { job_urn: jobRecord.job_urn });
      degraded.push('mission-fully-absent');
      return { submitted: false, degraded };
    }

    // --- Step 2: Gather evidence ---
    let evidence = [];
    try {
      const evResult = await cmEvidenceClient.gather(jobRecord);
      evidence = evResult.evidence || [];
      if (evResult.degraded?.length) degraded.push(...evResult.degraded.map(d => `evidence:${d}`));
    } catch (err) {
      log('thalamus_drafter_evidence_gather_error', { error: err.message, job_urn: jobRecord.job_urn });
      degraded.push('evidence-gather-error');
      // Not fail-closed — proceed without evidence (LLM gets the [NONE] block)
    }

    // --- Step 3: Graph context (wired by t3q-5) ---
    let gctx = null;
    if (graphContext?.enrich) {
      try {
        gctx = await graphContext.enrich({
          targets: [],
          urns: jobRecord.evidence_refs || [],
          jobRecord, // graph-context extracts seeds from intake_context internally
        });
        if (gctx.degraded?.length) degraded.push(...gctx.degraded.map(d => `graph:${d}`));
      } catch (err) {
        log('thalamus_drafter_graph_context_error', { error: err.message });
        degraded.push('graph-context-error');
      }
    }

    // --- Step 4: LLM drafter ---
    if (!llm.isAvailable()) {
      log('thalamus_drafter_llm_unavailable', { job_urn: jobRecord.job_urn });
      degraded.push('llm-unavailable');
      return { submitted: false, degraded };
    }

    const userContent = buildPrompt({ jobRecord, missionFrame, evidence, graphContext: gctx });

    let response;
    try {
      // Bug #2: system prompt is passed as an OPTION
      response = await llm.chat(
        [{ role: 'user', content: userContent }],
        { system: SYSTEM_PROMPT, maxTokens: llmConfig?.maxTokens },
      );
    } catch (err) {
      log('thalamus_drafter_llm_error', { error: err.message, job_urn: jobRecord.job_urn });
      degraded.push('llm-error');
      return { submitted: false, degraded };
    }

    const { ap, error: parseError } = parseResponse(response?.content);
    if (parseError || !ap) {
      log('thalamus_drafter_parse_error', { error: parseError, job_urn: jobRecord.job_urn });
      degraded.push(`parse-error: ${parseError}`);
      return { submitted: false, degraded };
    }

    // --- Step 4b: Lane verification (t3q-4) ---
    // The drafter must only produce APMs for write-lane work. If the LLM
    // produced targets that all resolve to R0, this is a mismatch — the
    // planner should have short-circuited to direct dispatch instead.
    if (laneSelector) {
      const laneResult = laneSelector.selectLane(
        { ...jobRecord, targets: ap.targets },
        { phase: 'final' },
      );
      if (laneResult.lane !== 'write') {
        log('thalamus_drafter_r0_ap_rejected', {
          job_urn: jobRecord.job_urn,
          lane: laneResult.lane,
          reasoning: laneResult.reasoning,
          targets: ap.targets,
        });
        degraded.push(`ap-drafter-r0-targets: ${laneResult.reasoning}`);
        return { submitted: false, degraded };
      }
    }

    // --- Step 5: Compose APM envelope ---
    const apmEnvelope = {
      type: 'APM',
      source_organ: 'Thalamus',
      target_organ: 'Nomos',
      reply_to: 'Thalamus',
      // message_id and timestamp assigned by Spine
      payload: {
        action:         ap.action,
        targets:        ap.targets, // organ:action format for Nomos / Arbiter
        risk_tier:      ap.risk_tier,
        evidence_refs:  ap.evidence_refs.length > 0 ? ap.evidence_refs : (jobRecord.evidence_refs || []),
        rollback_plan:  ap.rollback_plan,
        reason:         ap.reason,
        // job_reference for Nomos's audit trail — links the AP to the originating job in spine-state
        job_reference:  jobRecord.job_urn,
      },
    };

    // --- Step 6: Submit + capture ap_ref ---
    let apRef;
    try {
      const sendResult = await spine.send(apmEnvelope);
      apRef = sendResult?.message_id;
      if (!apRef) {
        log('thalamus_drafter_apm_no_message_id', { send_result: sendResult });
        degraded.push('apm-no-message-id');
        return { submitted: false, degraded };
      }
    } catch (err) {
      log('thalamus_drafter_apm_send_failed', { error: err.message, job_urn: jobRecord.job_urn });
      degraded.push(`apm-send-failed: ${err.message}`);
      return { submitted: false, degraded };
    }

    log('thalamus_apm_submitted', {
      job_urn: jobRecord.job_urn,
      ap_ref: apRef,
      risk_tier: ap.risk_tier,
      action: ap.action.slice(0, 80),
      target_count: ap.targets.length,
      evidence_count: ap.evidence_refs.length,
    });

    // --- Step 7: Transition the job to AWAITING_AUTH with full enrichment ---
    try {
      await jobLifecycle.markAwaitingAuth(jobRecord.job_urn, {
        ap_ref: apRef,
        risk_tier: ap.risk_tier,
        rollback_plan: ap.rollback_plan,
        targets: ap.targets,
        evidence_refs: ap.evidence_refs,
        mission_frame_ref: `${missionFrame?.msp?.version || 'no-msp'}:${missionFrame?.bor?.version || 'no-bor'}`,
        execution_plan: ap.execution_plan,
      });
    } catch (err) {
      // The APM was sent but the lifecycle transition failed. This is a
      // serious inconsistency: Nomos will adjudicate an AP whose job is still
      // PLANNING in our cache. Log loudly. The reconciler is the runtime
      // ATM-arrival path: when the ATM comes back, t3q-6 will see the job is
      // not in AWAITING_AUTH and either force-advance or surface an error.
      log('thalamus_drafter_post_send_transition_failed', {
        error: err.message,
        job_urn: jobRecord.job_urn,
        ap_ref: apRef,
      });
      degraded.push(`post-send-transition-failed: ${err.message}`);
      // Still return submitted: true — the APM is on the wire and Nomos will
      // process it. The caller can react to the degraded flag.
      return {
        submitted: true,
        ap_ref: apRef,
        risk_tier: ap.risk_tier,
        execution_plan: ap.execution_plan,
        degraded,
      };
    }

    return {
      submitted: true,
      ap_ref: apRef,
      risk_tier: ap.risk_tier,
      execution_plan: ap.execution_plan,
      degraded,
    };
  }

  // Expose llm for /health (t3q-7 probes llm.isAvailable() like Cortex does)
  draftAP.llm = llm;

  return { draftAP };
}
