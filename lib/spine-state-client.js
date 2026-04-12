/**
 * Thalamus -> spine-state HTTP client.
 *
 * spine-state holds the AUTHORITATIVE job lifecycle (the `job` machine pre-baked
 * in AOS-organ-spine-src/server/state/definitions.js). Thalamus is the only
 * caller that creates `job` entities — every other organ READS but never
 * transitions a job entity directly.
 *
 * Three operations:
 *   - createJobEntity(jobUrn, metadata)         -> POST /entities
 *   - transitionJob(jobUrn, fromState, toState, reason) -> POST /:entity_urn/transition
 *   - getJobEntity(jobUrn)                       -> GET /:entity_urn
 *   - listNonTerminalJobs()                      -> boot rehydration helper
 *
 * URL encoding: spine-state requires URNs in URL paths to be encodeURIComponent-
 * encoded by the client. The state route handler decodes them server-side.
 *
 * On any HTTP failure, throws SpineStateError. The lifecycle controller catches
 * these and either retries (transient) or surfaces them as JOB_STATE_CONFLICT
 * exceptions per the organ definition's exception taxonomy.
 *
 * On boot, listNonTerminalJobs() rehydrates the in-memory job-store. Note:
 * spine-state currently has no list-by-state endpoint — for MP-13 scope, this
 * function returns an empty array and logs a TODO. The Possible Upgrades
 * section of the intervention instruction tracks adding GET /entities?state=
 * to spine-state, which would enable proper rehydration. Until then, restart
 * loses non-terminal job tracking; new jobs continue to be processed normally.
 */

import { timedFetch } from './http-helpers.js';

function log(event, data = {}) {
  const entry = { timestamp: new Date().toISOString(), organ: 'Thalamus', event, ...data };
  process.stdout.write(JSON.stringify(entry) + '\n');
}

export class SpineStateError extends Error {
  constructor(op, status, detail) {
    super(`spine_state_${op}_failed: status=${status} detail=${detail}`);
    this.name = 'SpineStateError';
    this.op = op;
    this.status = status;
    this.detail = detail;
  }
}

export function createSpineStateClient({ spineUrl, timeoutMs = 3000 }) {
  async function createJobEntity(jobUrn, metadata) {
    const res = await timedFetch(`${spineUrl}/entities`, {
      method: 'POST',
      body: { entity_urn: jobUrn, entity_type: 'job', metadata },
      timeoutMs,
    });
    if (!res.ok) {
      log('thalamus_spine_state_create_failed', { job_urn: jobUrn, status: res.status, error: res.error });
      throw new SpineStateError('create_entity', res.status, res.error || res.data?.error);
    }
    return res.data;
  }

  async function transitionJob(jobUrn, fromState, toState, reason) {
    const encoded = encodeURIComponent(jobUrn);
    const res = await timedFetch(`${spineUrl}/${encoded}/transition`, {
      method: 'POST',
      body: { from_state: fromState, to_state: toState, reason, actor: 'Thalamus' },
      timeoutMs,
    });
    if (!res.ok) {
      log('thalamus_spine_state_transition_failed', {
        job_urn: jobUrn, from: fromState, to: toState, status: res.status, error: res.error,
      });
      throw new SpineStateError('transition', res.status, res.error || res.data?.error);
    }
    return res.data;
  }

  async function getJobEntity(jobUrn) {
    const encoded = encodeURIComponent(jobUrn);
    const res = await timedFetch(`${spineUrl}/${encoded}`, { method: 'GET', timeoutMs });
    if (res.status === 404) return null;
    if (!res.ok) {
      throw new SpineStateError('get_entity', res.status, res.error || res.data?.error);
    }
    return res.data;
  }

  async function listNonTerminalJobs() {
    // TODO: spine-state has no list-by-state endpoint yet. Track in Thalamus
    // Possible Upgrades. For MP-13, return [] — restart loses in-memory job
    // tracking. New jobs continue to be processed normally.
    log('thalamus_spine_state_list_not_implemented', { reason: 'spine-state has no GET /entities filter endpoint' });
    return [];
  }

  return { createJobEntity, transitionJob, getJobEntity, listNonTerminalJobs };
}
