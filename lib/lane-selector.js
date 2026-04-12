/**
 * Lane selector — deterministic R0 vs write-lane classifier.
 *
 * Two phases:
 *   - Phase A (preliminary): consult jobRecord.intake_context to make a coarse
 *     R0 / write / pending decision. Used by the planner before invoking the
 *     AP drafter, to short-circuit obviously-read-only jobs.
 *   - Phase B (final): consult jobRecord.targets (populated by the AP drafter)
 *     and the classifier table. Authoritative.
 *
 * Conservative default: any target not in the classifier is treated as 'write'
 * and added to `ambiguous_targets` for operator review.
 *
 * The classifier table is loaded from config/action-classifier.json at boot.
 * If the file is missing or malformed, the loader falls back to a minimal
 * in-code default that classifies everything as 'write' (the safest fail-
 * closed posture). Boot logs the fallback so operators see it.
 *
 * Returns: { lane: 'r0' | 'write' | 'pending', reasoning, write_targets, r0_targets, ambiguous_targets }
 *
 * The 'pending' return value is ONLY produced by Phase A when the heuristic
 * cannot decide. Phase B never returns pending — it always commits to r0 or
 * write (defaulting to write under uncertainty).
 */

import { readFile } from 'node:fs/promises';

function log(event, data = {}) {
  const entry = { timestamp: new Date().toISOString(), organ: 'Thalamus', event, ...data };
  process.stdout.write(JSON.stringify(entry) + '\n');
}

const FALLBACK_TABLE = {
  actions: {},
  intake_heuristic: {
    r0_keywords: ['read', 'query', 'show', 'get'],
    write_keywords: ['create', 'update', 'delete', 'write', 'ingest'],
  },
};

export async function loadClassifierTable(classifierPath) {
  try {
    const content = await readFile(classifierPath, 'utf-8');
    const parsed = JSON.parse(content);
    if (!parsed.actions || typeof parsed.actions !== 'object') {
      log('thalamus_classifier_invalid_shape', { path: classifierPath });
      return FALLBACK_TABLE;
    }
    log('thalamus_classifier_loaded', {
      path: classifierPath,
      action_count: Object.keys(parsed.actions).length,
      schema_version: parsed.$schema_version,
    });
    return parsed;
  } catch (err) {
    log('thalamus_classifier_load_failed', { path: classifierPath, error: err.message });
    return FALLBACK_TABLE;
  }
}

export function createLaneSelector({ table, fallback = 'write' }) {
  const actions = table.actions || {};
  const heuristic = table.intake_heuristic || FALLBACK_TABLE.intake_heuristic;

  function classifyTarget(target) {
    if (typeof target !== 'string') return { lane: fallback, reason: 'non-string-target' };
    const lookup = actions[target];
    if (lookup === 'r0' || lookup === 'write') {
      return { lane: lookup, reason: 'classified' };
    }
    return { lane: fallback, reason: 'unknown-target' };
  }

  function phaseAHeuristic(jobRecord) {
    const ic = jobRecord?.intake_context || {};
    let text = '';
    if (ic.kind === 'cortex_goal') {
      text = `${ic.target_state || ''} ${jobRecord.description || ''}`.toLowerCase();
    } else if (ic.kind === 'receptor_request') {
      text = `${ic.intent_label || ''} ${jobRecord.description || ''}`.toLowerCase();
    } else {
      return { lane: 'pending', reasoning: 'unknown-intake-kind', write_targets: [], r0_targets: [], ambiguous_targets: [] };
    }

    const r0Keywords = heuristic.r0_keywords || [];
    const writeKeywords = heuristic.write_keywords || [];
    const hasWrite = writeKeywords.some(k => text.includes(k));
    const hasR0 = r0Keywords.some(k => text.includes(k));

    if (hasWrite) {
      return { lane: 'pending', reasoning: 'phase-a-write-keyword-detected-defer-to-drafter', write_targets: [], r0_targets: [], ambiguous_targets: [] };
    }
    if (hasR0 && !hasWrite) {
      return { lane: 'r0', reasoning: 'phase-a-r0-only-keywords', write_targets: [], r0_targets: [], ambiguous_targets: [] };
    }
    return { lane: 'pending', reasoning: 'phase-a-no-decisive-keyword', write_targets: [], r0_targets: [], ambiguous_targets: [] };
  }

  function phaseBClassify(jobRecord) {
    const targets = Array.isArray(jobRecord?.targets) ? jobRecord.targets : [];
    if (targets.length === 0) {
      return {
        lane: fallback,
        reasoning: 'phase-b-no-targets-default-fallback',
        write_targets: [],
        r0_targets: [],
        ambiguous_targets: [],
      };
    }
    const writeTargets = [];
    const r0Targets = [];
    const ambiguousTargets = [];

    for (const target of targets) {
      const { lane, reason } = classifyTarget(target);
      if (lane === 'r0') {
        r0Targets.push(target);
      } else {
        writeTargets.push(target);
        if (reason === 'unknown-target') ambiguousTargets.push(target);
      }
    }

    if (writeTargets.length > 0) {
      const reasoning = ambiguousTargets.length > 0
        ? `phase-b-mixed-with-${ambiguousTargets.length}-unknown-defaulted-to-write`
        : 'phase-b-write-target-detected';
      if (ambiguousTargets.length > 0) {
        log('thalamus_lane_ambiguous', { ambiguous_targets: ambiguousTargets, job_urn: jobRecord.job_urn });
      }
      return { lane: 'write', reasoning, write_targets: writeTargets, r0_targets: r0Targets, ambiguous_targets: ambiguousTargets };
    }

    return { lane: 'r0', reasoning: 'phase-b-all-targets-r0', write_targets: [], r0_targets: r0Targets, ambiguous_targets: [] };
  }

  function selectLane(jobRecord, { phase = 'final' } = {}) {
    if (phase === 'preliminary') {
      const result = phaseAHeuristic(jobRecord);
      log('thalamus_lane_phase_a', { job_urn: jobRecord?.job_urn, lane: result.lane, reasoning: result.reasoning });
      return result;
    }
    const result = phaseBClassify(jobRecord);
    log('thalamus_lane_phase_b', {
      job_urn: jobRecord?.job_urn,
      lane: result.lane,
      reasoning: result.reasoning,
      write_count: result.write_targets.length,
      r0_count: result.r0_targets.length,
      ambiguous_count: result.ambiguous_targets.length,
    });
    return result;
  }

  return { selectLane, classifyTarget, FALLBACK_LANE: fallback };
}
