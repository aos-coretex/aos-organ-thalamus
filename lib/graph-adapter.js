/**
 * Thalamus Graph adapter — HTTP client for the Graph organ.
 *
 * Read-only: Thalamus never writes to Graph. Five operations exposed:
 *  - queryConcepts(sql, params) — used by mission-loader for active MSP lookup
 *  - getConcept(urn)            — used for direct URN resolution
 *  - getBindings(urn)           — bindings touching a URN (via POST /query SQL)
 *  - traverseFrom(urn, opts)    — BFS traversal from a seed URN
 *  - getConceptsByType(type, limit) — concepts filtered by data.type
 *
 * Every request carries X-Organ-Name: Thalamus for Graph telemetry.
 * Uses the shared `timedFetch` helper so all outbound HTTP is abort-bounded
 * by `timeoutMs` (default 3000ms; overridable via config.graphTimeoutMs).
 * On abort, throws `GraphTimeoutError`; on other HTTP failures, throws the
 * usual `graph_query_failed` / `graph_get_concept_failed` errors. Mission
 * loader catches any of these and flags `graph-unreachable`.
 *
 * Shared between relay t3q-3 (mission-loader + AP drafting) and relay t3q-5
 * (graph context enrichment). Relay t3q-5 extends this with traversal-specific
 * helpers (getBindings, traverseFrom).
 */

import { timedFetch } from './http-helpers.js';

function log(event, data = {}) {
  const entry = { timestamp: new Date().toISOString(), organ: 'Thalamus', event, ...data };
  process.stdout.write(JSON.stringify(entry) + '\n');
}

export class GraphTimeoutError extends Error {
  constructor({ url, timeoutMs }) {
    super(`graph_timeout: ${url} exceeded ${timeoutMs}ms`);
    this.name = 'GraphTimeoutError';
    this.url = url;
    this.timeoutMs = timeoutMs;
    this.error = 'timeout';
  }
}

export function createGraphAdapter({ graphUrl, timeoutMs = 3000 }) {
  async function queryConcepts(sql, params = []) {
    const url = `${graphUrl}/query`;
    const res = await timedFetch(url, {
      method: 'POST',
      body: { sql, params },
      timeoutMs,
    });
    if (!res.ok) {
      if (res.error === 'timeout') {
        log('thalamus_graph_query_timeout', { url, timeoutMs });
        throw new GraphTimeoutError({ url, timeoutMs });
      }
      const err = new Error(`graph_query_failed: ${res.error}`);
      err.status = res.status;
      log('thalamus_graph_query_error', { url, status: res.status, error: res.error });
      throw err;
    }
    return res.data;
  }

  async function getConcept(urn) {
    const encoded = encodeURIComponent(urn);
    const url = `${graphUrl}/concepts/${encoded}`;
    const res = await timedFetch(url, { method: 'GET', timeoutMs });
    if (res.status === 404) return null;
    if (!res.ok) {
      if (res.error === 'timeout') {
        log('thalamus_graph_get_concept_timeout', { url, timeoutMs });
        throw new GraphTimeoutError({ url, timeoutMs });
      }
      const err = new Error(`graph_get_concept_failed: ${res.error}`);
      err.status = res.status;
      throw err;
    }
    return res.data;
  }

  // --- Traversal helpers (t3q-5) ---

  /**
   * getBindings — fetch bindings touching a URN.
   *
   * Graph organ has no dedicated /bindings?source_urn= endpoint (verified
   * against AOS-organ-graph-src/server/routes/bindings.js — only GET /:ubn).
   * Uses POST /query SQL against class_bindings table.
   * Graph organ schema: data.from_urn, data.to_urn (not source_urn/target_urn).
   */
  async function getBindings(sourceUrn) {
    try {
      const sql = `SELECT ubn, data, created_at FROM class_bindings
                   WHERE json_extract(data, '$.from_urn') = $1
                      OR json_extract(data, '$.to_urn') = $1
                   LIMIT 50`;
      const result = await queryConcepts(sql, [sourceUrn]);
      const rows = result?.rows || [];
      return { bindings: rows, degraded: rows.length === 0 ? [] : [] };
    } catch (err) {
      log('thalamus_graph_bindings_query_error', { error: err.message, source_urn: sourceUrn });
      return { bindings: [], degraded: ['graph-bindings-query-failed'] };
    }
  }

  /**
   * traverseFrom — BFS-style traversal from a seed URN.
   * Conservative caps: depth <= 3, limit <= 200. Never revisits URNs.
   */
  async function traverseFrom(seedUrn, { depth = 1, limit = 50 } = {}) {
    const cappedDepth = Math.min(depth, 3);
    const cappedLimit = Math.min(limit, 200);
    const visited = new Set();
    const entities = [];
    const bindings = [];
    const queue = [{ urn: seedUrn, hops: 0 }];
    const degraded = [];

    while (queue.length > 0 && entities.length < cappedLimit) {
      const { urn, hops } = queue.shift();
      if (visited.has(urn)) continue;
      visited.add(urn);

      let concept;
      try {
        concept = await getConcept(urn);
      } catch (err) {
        degraded.push(`graph-traverse-concept-failed: ${urn}`);
        continue;
      }
      if (concept) entities.push(concept);

      if (hops >= cappedDepth) continue;

      let bindingResult;
      try {
        bindingResult = await getBindings(urn);
      } catch (err) {
        degraded.push(`graph-traverse-bindings-failed: ${urn}`);
        continue;
      }
      bindings.push(...bindingResult.bindings);
      if (bindingResult.degraded.length) degraded.push(...bindingResult.degraded);

      // Enqueue connected URNs for the next hop
      for (const b of bindingResult.bindings) {
        const bData = typeof b.data === 'string' ? JSON.parse(b.data) : (b.data || {});
        const nextUrn = bData.to_urn === urn ? bData.from_urn : bData.to_urn;
        if (nextUrn && !visited.has(nextUrn)) {
          queue.push({ urn: nextUrn, hops: hops + 1 });
        }
      }
    }

    return {
      entities,
      bindings,
      depth_reached: cappedDepth,
      seeds_used: [seedUrn],
      degraded: [...new Set(degraded)],
    };
  }

  /**
   * getConceptsByType — concepts filtered by data.type field.
   */
  async function getConceptsByType(type, limit = 20) {
    try {
      const sql = `SELECT urn, data, created_at FROM concepts WHERE json_extract(data, '$.type') = $1 LIMIT $2`;
      const result = await queryConcepts(sql, [type, limit]);
      return { concepts: result?.rows || [], degraded: [] };
    } catch (err) {
      log('thalamus_graph_concepts_by_type_error', { error: err.message, type });
      return { concepts: [], degraded: ['graph-concepts-by-type-failed'] };
    }
  }

  return { queryConcepts, getConcept, getBindings, traverseFrom, getConceptsByType };
}
