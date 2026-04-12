/**
 * Mission loader — composes a MissionFrame from:
 *   1. Active msp_version concept read via Graph adapter (POST /query)
 *      Extracts data.raw_text — Senate g1n-2 Fix 2 threading (required).
 *   2. Active BoR raw text fetched from Arbiter GET /bor/raw
 *      Added by the parallel repair brief `repair-agent-arbiter-bor-raw-endpoint`.
 *
 * Cache semantics:
 *   - Mission data is cached with TTL (default 10min, configurable).
 *   - Cache is invalidated by `msp_updated` / `bor_updated` broadcasts wired
 *     in relay t3q-7. This loader exposes invalidate() and the broadcast
 *     handler calls it.
 *   - Each AP draft cycle calls loadMission(); the cache short-circuits
 *     repeated reads within the TTL window.
 *
 * Degradation flags:
 *   - `msp-missing-from-graph` — Graph returned no active msp_version
 *   - `msp-raw-text-absent`    — concept exists but data.raw_text is empty
 *                                (pre-Fix-2 legacy concept compat)
 *   - `graph-unreachable`      — Graph adapter error
 *   - `bor-unavailable`        — Arbiter returned null (endpoint down/missing)
 *   - `arbiter-unreachable`    — Arbiter endpoint missing or network error
 *
 * 2026-04-11 amendment: Thalamus reads both MSP and BoR raw text as
 * constitutional conditioning. Thalamus NEVER rules on scope. Scope rulings
 * belong to Arbiter at Nomos -> Arbiter adjudication time.
 */

function log(event, data = {}) {
  const entry = { timestamp: new Date().toISOString(), organ: 'Thalamus', event, ...data };
  process.stdout.write(JSON.stringify(entry) + '\n');
}

export function createMissionLoader({ graphAdapter, arbiterClient, cacheTtlMs = 600000 }) {
  let cached = null;
  let cacheExpiresAt = 0;

  async function loadMSPFromGraph() {
    const degraded = [];
    try {
      // Senate g1n-2 writes: type='msp_version', data.status='active'
      const sql = `SELECT urn, data, created_at
                   FROM concepts
                   WHERE data->>'type' = 'msp_version'
                     AND data->>'status' = 'active'
                   ORDER BY created_at DESC
                   LIMIT 1`;
      const result = await graphAdapter.queryConcepts(sql, []);
      const rows = result?.rows || [];
      if (rows.length === 0) {
        log('thalamus_msp_not_found');
        degraded.push('msp-missing-from-graph');
        return { msp: null, degraded };
      }
      const row = rows[0];
      const data = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
      if (!data.raw_text) {
        log('thalamus_msp_raw_text_absent', { urn: row.urn });
        degraded.push('msp-raw-text-absent');
        return {
          msp: {
            urn: row.urn,
            version: data.version || 'unknown',
            hash: data.hash || '',
            raw_text: '',
            status: data.status,
            activated_at: data.activated_at || row.created_at,
          },
          degraded,
        };
      }
      return {
        msp: {
          urn: row.urn,
          version: data.version,
          hash: data.hash,
          raw_text: data.raw_text,
          status: data.status,
          activated_at: data.activated_at || row.created_at,
        },
        degraded: [],
      };
    } catch (err) {
      log('thalamus_graph_unreachable_for_msp', { error: err.message });
      return { msp: null, degraded: ['graph-unreachable'] };
    }
  }

  async function loadBoRFromArbiter() {
    try {
      const bor = await arbiterClient.getBoRRaw();
      if (bor === null) {
        return { bor: null, degraded: ['bor-unavailable'] };
      }
      return { bor, degraded: [] };
    } catch (err) {
      log('thalamus_arbiter_unreachable_for_bor', { error: err.message });
      return { bor: null, degraded: ['arbiter-unreachable'] };
    }
  }

  async function loadMission() {
    const now = Date.now();
    if (cached && now < cacheExpiresAt) {
      return cached;
    }

    const [mspResult, borResult] = await Promise.all([
      loadMSPFromGraph(),
      loadBoRFromArbiter(),
    ]);

    const frame = {
      msp: mspResult.msp,
      bor: borResult.bor,
      loaded_at: new Date(now).toISOString(),
      cache_expires_at: new Date(now + cacheTtlMs).toISOString(),
      degraded: [...mspResult.degraded, ...borResult.degraded],
    };

    log('thalamus_mission_loaded', {
      msp_present: !!frame.msp,
      msp_version: frame.msp?.version || null,
      bor_present: !!frame.bor,
      bor_version: frame.bor?.version || null,
      degraded: frame.degraded,
    });

    cached = frame;
    cacheExpiresAt = now + cacheTtlMs;
    return frame;
  }

  function invalidate(reason) {
    log('thalamus_mission_cache_invalidated', { reason });
    cached = null;
    cacheExpiresAt = 0;
  }

  function peekCache() {
    return cached;
  }

  return { loadMission, invalidate, peekCache };
}
