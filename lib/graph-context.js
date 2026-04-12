/**
 * Graph context enricher — gathers structural identity for AP drafting.
 *
 * Calls Graph adapter for entities + bindings starting from URN seeds in
 * the JobRecord. Read-only. Best-effort: failures degrade gracefully and
 * the drafter proceeds without graph context.
 *
 * Caps: 50 entities, 100 bindings total. Above-cap items are silently
 * dropped (the LLM doesn't need 500 entities to reason about an action).
 *
 * Per organ definition S6 GRAPHHEIGHT_READ_FAILED: degrade to
 * non-graph-augmented mode. The degraded list signals this to the drafter,
 * which logs and proceeds.
 */

import { extractUrnSeeds } from './urn-seeds.js';

const MAX_ENTITIES = 50;
const MAX_BINDINGS = 100;

function log(event, data = {}) {
  const entry = { timestamp: new Date().toISOString(), organ: 'Thalamus', event, ...data };
  process.stdout.write(JSON.stringify(entry) + '\n');
}

export function createGraphContext({ graphAdapter }) {
  async function enrich({ targets = [], urns = [], jobRecord = null } = {}) {
    const allSeeds = new Set([...urns]);
    if (jobRecord) {
      for (const seed of extractUrnSeeds(jobRecord)) allSeeds.add(seed);
    }
    const seedArray = Array.from(allSeeds);

    if (seedArray.length === 0) {
      log('thalamus_graph_context_no_seeds', { job_urn: jobRecord?.job_urn });
      return { entities: [], bindings: [], seeds_used: [], degraded: ['graph-no-seeds'] };
    }

    const entities = [];
    const bindings = [];
    const degraded = [];
    let allFailed = true;

    for (const seed of seedArray) {
      if (entities.length >= MAX_ENTITIES) break;
      try {
        const result = await graphAdapter.traverseFrom(seed, { depth: 1, limit: 20 });
        if (result.entities.length > 0) allFailed = false;
        for (const e of result.entities) {
          if (entities.length < MAX_ENTITIES) entities.push(e);
        }
        for (const b of result.bindings) {
          if (bindings.length < MAX_BINDINGS) bindings.push(b);
        }
        if (result.degraded?.length) degraded.push(...result.degraded);
      } catch (err) {
        log('thalamus_graph_context_seed_failed', { seed, error: err.message });
        degraded.push(`graph-seed-failed: ${seed}`);
      }
    }

    if (allFailed && seedArray.length > 0) {
      degraded.push('graphheight-read-failed');
    }

    log('thalamus_graph_context_collected', {
      job_urn: jobRecord?.job_urn,
      seed_count: seedArray.length,
      entity_count: entities.length,
      binding_count: bindings.length,
      degraded_count: degraded.length,
    });

    return {
      entities,
      bindings,
      seeds_used: seedArray,
      degraded: [...new Set(degraded)],
    };
  }

  return { enrich };
}
