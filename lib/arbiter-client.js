/**
 * Thalamus Arbiter client — HTTP read-only for BoR raw text.
 *
 * Depends on Arbiter's `GET /bor/raw` endpoint (shipped per
 * repair-agent-arbiter-bor-raw-endpoint, verified at
 * AOS-organ-arbiter-src/server/routes/bor.js line 45).
 *
 * If that endpoint is missing (404) or Arbiter is down (503), this client
 * returns null and the mission loader flags the draft as BoR-degraded.
 *
 * Thalamus reads BoR as constitutional conditioning for AP drafting —
 * not as a scope oracle. Scope rulings remain Arbiter's exclusive domain
 * at Nomos -> Arbiter adjudication time. See 2026-04-11 amendment.
 */

function log(event, data = {}) {
  const entry = { timestamp: new Date().toISOString(), organ: 'Thalamus', event, ...data };
  process.stdout.write(JSON.stringify(entry) + '\n');
}

export function createArbiterClient({ arbiterUrl, timeoutMs = 5000 }) {
  async function getBoRRaw() {
    const url = `${arbiterUrl}/bor/raw`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'GET',
        headers: { 'X-Organ-Name': 'Thalamus' },
        signal: controller.signal,
      });
      if (res.status === 503) {
        log('thalamus_arbiter_bor_unavailable', { reason: 'BOR_NOT_LOADED' });
        return null;
      }
      if (res.status === 404) {
        log('thalamus_arbiter_bor_endpoint_missing', { url, note: 'repair-agent-arbiter-bor-raw-endpoint has not landed' });
        return null;
      }
      if (!res.ok) {
        log('thalamus_arbiter_bor_error', { status: res.status });
        return null;
      }
      const data = await res.json();
      return {
        version: data.version,
        hash: data.hash,
        raw_text: data.raw_text,
        effective_since: data.effective_since,
        loaded_at: data.loaded_at,
      };
    } catch (err) {
      log('thalamus_arbiter_bor_fetch_error', { error: err.name === 'AbortError' ? 'timeout' : err.message });
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  return { getBoRRaw };
}
