/**
 * HTTP helpers for Thalamus's direct-HTTP clients.
 *
 * timedFetch wraps fetch() with an AbortController timeout and an X-Organ-Name
 * header. Returns { ok, status, data, error } — NEVER throws. Callers inspect
 * the return shape and flag degradation accordingly.
 */

export async function timedFetch(url, { method = 'GET', headers = {}, body, timeoutMs = 5000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const opts = {
      method,
      headers: { 'X-Organ-Name': 'Thalamus', ...headers },
      signal: controller.signal,
    };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = typeof body === 'string' ? body : JSON.stringify(body);
    }
    const res = await fetch(url, opts);
    let data = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    return {
      ok: res.ok,
      status: res.status,
      data,
      error: res.ok ? null : `HTTP ${res.status}`,
    };
  } catch (err) {
    const error = err.name === 'AbortError' ? 'timeout' : err.message || 'network_error';
    return { ok: false, status: 0, data: null, error };
  } finally {
    clearTimeout(timer);
  }
}
