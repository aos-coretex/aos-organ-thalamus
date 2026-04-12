/**
 * Health/introspect builders — extracted for testability.
 *
 * Returns FLAT objects per bug #9 — the shared-lib wraps healthCheck output
 * under `checks` and introspectCheck output under `extra`.
 */

export function buildHealthCheck({ probes, jobStore, missionLoader, llm }) {
  return async function healthCheck() {
    const stats = jobStore.stats();
    return {
      spine_state_reachable: probes.spine_state,
      nomos_reachable:       probes.nomos,
      cerberus_reachable:    probes.cerberus,
      graph_reachable:       probes.graph,
      arbiter_reachable:     probes.arbiter,
      radiant_reachable:     probes.radiant,
      minder_reachable:      probes.minder,
      hippocampus_reachable: probes.hippocampus,
      syntra_reachable:      probes.syntra,
      active_jobs: stats.total - (stats.by_state.SUCCEEDED + stats.by_state.DENIED + stats.by_state.FAILED),
      pending_proposals: stats.by_state.AWAITING_AUTH,
      mission_cache_loaded: missionLoader?.peekCache?.() !== null,
      llm_available: !!llm?.isAvailable?.(),
      total_jobs: stats.total,
      jobs_by_state: stats.by_state,
    };
  };
}

export function buildIntrospectCheck({ jobStore, missionLoader, dependencies }) {
  return async function introspectCheck() {
    const stats = jobStore.stats();
    return {
      total_jobs: stats.total,
      jobs_by_state: stats.by_state,
      mission_cache_loaded: missionLoader?.peekCache?.() !== null,
      dependencies_configured: dependencies,
    };
  };
}
