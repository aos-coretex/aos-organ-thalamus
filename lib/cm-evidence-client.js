/**
 * CM evidence client — direct HTTP reads against Collective Memory organs
 * for AP drafting evidence gathering.
 *
 * Same Path A direct-HTTP pattern as Cortex's cm-client.js (RFI-1 Q1 from
 * MP-12). Thalamus is a heavy reader of the Collective Memory per the organ
 * definition S2.2. This client gathers evidence relevant to a specific job
 * being drafted — it is NOT the periodic-snapshot world-state reader Cortex
 * runs (Cortex's pattern is one-shot per assessment cycle; Thalamus's pattern
 * is one-shot per AP draft, scoped to the job's intake context).
 *
 * Inputs: jobRecord (from t3q-1) — uses jobRecord.intake_context for query
 * shaping. Specifically:
 *   - cortex_goal jobs: query evidence_refs from intake_context (already
 *     surfaced by Cortex), plus a small Radiant context query keyed by
 *     description.
 *   - receptor_request jobs: query Minder for user_identity observations,
 *     query Hippocampus for session_id conversation history, query Syntra
 *     for intent-keyed semantic search (intent_label).
 *
 * Outputs: { evidence: [{ source, content, urn? }], degraded: [] }
 *
 * Per-organ failure is NEVER fatal — partial evidence is still useful.
 * Each failed organ adds a tag to `degraded`; the AP drafter sees the
 * degraded list and can flag it on the resulting AP.
 */

import { timedFetch } from './http-helpers.js';

function log(event, data = {}) {
  const entry = { timestamp: new Date().toISOString(), organ: 'Thalamus', event, ...data };
  process.stdout.write(JSON.stringify(entry) + '\n');
}

export function createCmEvidenceClient({
  radiantUrl, minderUrl, hippocampusUrl, syntraUrl, timeoutMs = 5000,
}) {
  async function gatherForCortexGoal(jobRecord) {
    const evidence = [];
    const degraded = [];

    // 1. Existing evidence_refs from Cortex — already URN'd, surface as-is
    for (const ref of jobRecord.evidence_refs || []) {
      evidence.push({ source: 'cortex_passthrough', urn: ref, content: `[Cortex evidence ref: ${ref}]` });
    }

    // 2. Radiant context query keyed by description
    try {
      const res = await timedFetch(`${radiantUrl}/query`, {
        method: 'POST',
        body: { query: jobRecord.description, limit: 5 },
        timeoutMs,
      });
      if (res.ok && Array.isArray(res.data?.blocks)) {
        for (const block of res.data.blocks) {
          evidence.push({ source: 'Radiant', content: block.content || JSON.stringify(block), urn: block.urn });
        }
      } else {
        degraded.push('radiant-degraded');
      }
    } catch (err) {
      log('thalamus_evidence_radiant_error', { error: err.message });
      degraded.push('radiant-unreachable');
    }

    return { evidence, degraded };
  }

  async function gatherForReceptorRequest(jobRecord) {
    const evidence = [];
    const degraded = [];
    const ic = jobRecord.intake_context || {};

    // 1. Minder — observations for user_identity
    if (ic.user_identity) {
      try {
        const res = await timedFetch(`${minderUrl}/peers/${encodeURIComponent(ic.user_identity)}/observations`, {
          method: 'GET',
          timeoutMs,
        });
        if (res.ok && Array.isArray(res.data?.observations)) {
          for (const obs of res.data.observations.slice(0, 5)) {
            evidence.push({ source: 'Minder', content: obs.content || JSON.stringify(obs), urn: obs.urn });
          }
        } else {
          degraded.push('minder-degraded');
        }
      } catch (err) {
        degraded.push('minder-unreachable');
      }
    }

    // 2. Hippocampus — recent conversation for session_id
    if (ic.session_id) {
      try {
        const res = await timedFetch(`${hippocampusUrl}/sessions/${encodeURIComponent(ic.session_id)}/recent`, {
          method: 'GET',
          timeoutMs,
        });
        if (res.ok && Array.isArray(res.data?.summaries)) {
          for (const s of res.data.summaries.slice(0, 3)) {
            evidence.push({ source: 'Hippocampus', content: s.summary || JSON.stringify(s), urn: s.urn });
          }
        } else {
          degraded.push('hippocampus-degraded');
        }
      } catch (err) {
        degraded.push('hippocampus-unreachable');
      }
    }

    // 3. Syntra — semantic search keyed by intent_label
    if (ic.intent_label) {
      try {
        const res = await timedFetch(`${syntraUrl}/search`, {
          method: 'POST',
          body: { query: ic.intent_label, limit: 3 },
          timeoutMs,
        });
        if (res.ok && Array.isArray(res.data?.results)) {
          for (const r of res.data.results) {
            evidence.push({ source: 'Syntra', content: r.text || JSON.stringify(r), urn: r.urn });
          }
        } else {
          degraded.push('syntra-degraded');
        }
      } catch (err) {
        degraded.push('syntra-unreachable');
      }
    }

    return { evidence, degraded };
  }

  async function gather(jobRecord) {
    if (jobRecord?.intake_context?.kind === 'cortex_goal') {
      return gatherForCortexGoal(jobRecord);
    }
    if (jobRecord?.intake_context?.kind === 'receptor_request') {
      return gatherForReceptorRequest(jobRecord);
    }
    log('thalamus_evidence_unknown_intake_kind', { kind: jobRecord?.intake_context?.kind });
    return { evidence: [], degraded: ['unknown-intake-kind'] };
  }

  return { gather, gatherForCortexGoal, gatherForReceptorRequest };
}
