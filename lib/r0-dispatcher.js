/**
 * R0 dispatcher — direct HTTP read against department organs.
 *
 * ARCHITECTURAL DEVIATION FROM META PROMPT — see relay t3q-6 S1.
 * No department organ currently has an r0_read_request Spine handler.
 * This module uses direct HTTP (Path A pattern from Cortex's cm-client.js)
 * with Spine OTM broadcasts for observability. If the architect later
 * decides to switch to Spine-based R0 reads, this is a single-module swap.
 */

import { timedFetch } from './http-helpers.js';
import { readFile } from 'node:fs/promises';

function log(event, data = {}) {
  const entry = { timestamp: new Date().toISOString(), organ: 'Thalamus', event, ...data };
  process.stdout.write(JSON.stringify(entry) + '\n');
}

export async function loadR0EndpointsTable(path) {
  try {
    const content = await readFile(path, 'utf-8');
    const parsed = JSON.parse(content);
    if (!parsed.actions) {
      log('thalamus_r0_endpoints_invalid_shape');
      return { actions: {} };
    }
    return parsed;
  } catch (err) {
    log('thalamus_r0_endpoints_load_failed', { path, error: err.message });
    return { actions: {} };
  }
}

function resolveTemplate(template, jobRecord) {
  if (template === null || template === undefined) return null;
  if (typeof template === 'string') {
    return template.replace(/\$\.(\w+)/g, (_, field) => {
      if (jobRecord[field] !== undefined && jobRecord[field] !== null) return String(jobRecord[field]);
      const ic = jobRecord.intake_context || {};
      if (ic[field] !== undefined && ic[field] !== null) return String(ic[field]);
      return '';
    });
  }
  if (typeof template === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(template)) {
      out[k] = resolveTemplate(v, jobRecord);
    }
    return out;
  }
  return template;
}

export function createR0Dispatcher({ endpointsTable, organUrls, timeoutMs = 5000 }) {
  async function dispatchOne(target, jobRecord) {
    const action = endpointsTable.actions[target];
    if (!action) {
      log('thalamus_r0_action_not_implemented', { target, job_urn: jobRecord.job_urn });
      return { target, ok: false, error: 'r0_action_not_implemented' };
    }
    const baseUrl = organUrls[action.organ_url_key];
    if (!baseUrl) {
      log('thalamus_r0_organ_url_missing', { target, key: action.organ_url_key });
      return { target, ok: false, error: 'organ_url_missing' };
    }
    const path = resolveTemplate(action.path, jobRecord);
    const url = `${baseUrl}${path}`;
    const body = action.body_template ? resolveTemplate(action.body_template, jobRecord) : undefined;

    const result = await timedFetch(url, {
      method: action.method,
      body: action.method === 'GET' ? undefined : body,
      timeoutMs,
    });

    if (!result.ok) {
      log('thalamus_r0_target_failed', { target, url, status: result.status, error: result.error });
      return { target, ok: false, status: result.status, error: result.error || `HTTP ${result.status}` };
    }
    return { target, ok: true, status: result.status, data: result.data };
  }

  async function dispatchAll(jobRecord, targets) {
    const t0 = Date.now();
    log('thalamus_r0_dispatch_starting', { job_urn: jobRecord.job_urn, target_count: targets.length });

    const settled = await Promise.allSettled(targets.map(t => dispatchOne(t, jobRecord)));

    const results = [];
    const failures = [];
    for (const s of settled) {
      if (s.status === 'fulfilled') {
        if (s.value.ok) results.push(s.value);
        else failures.push(s.value);
      } else {
        failures.push({ target: 'unknown', ok: false, error: s.reason?.message || 'unknown_promise_rejection' });
      }
    }

    log('thalamus_r0_dispatch_finished', {
      job_urn: jobRecord.job_urn,
      ok_count: results.length,
      fail_count: failures.length,
      duration_ms: Date.now() - t0,
    });

    return {
      executed: results.length > 0,
      results,
      failures,
      total: targets.length,
      duration_ms: Date.now() - t0,
    };
  }

  return { dispatchAll, dispatchOne };
}
