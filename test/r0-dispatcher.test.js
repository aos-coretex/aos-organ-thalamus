import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createR0Dispatcher, loadR0EndpointsTable } from '../lib/r0-dispatcher.js';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

function createFakeOrganServer(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

const baseJob = { job_urn: 'urn:llm-ops:job:test', description: 'test query', intake_context: { kind: 'cortex_goal' } };

test('dispatchAll runs targets in parallel and returns results', async () => {
  const fake = await createFakeOrganServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: 'ok' }));
  });
  try {
    const table = { actions: { 'Radiant:query': { organ_url_key: 'radiantUrl', method: 'POST', path: '/query', body_template: { query: '$.description' } } } };
    const dispatcher = createR0Dispatcher({ endpointsTable: table, organUrls: { radiantUrl: fake.url }, timeoutMs: 2000 });
    const result = await dispatcher.dispatchAll(baseJob, ['Radiant:query']);
    assert.equal(result.results.length, 1);
    assert.equal(result.failures.length, 0);
    assert.equal(result.results[0].ok, true);
  } finally { await fake.close(); }
});

test('unknown action returns r0_action_not_implemented', async () => {
  const dispatcher = createR0Dispatcher({ endpointsTable: { actions: {} }, organUrls: {}, timeoutMs: 2000 });
  const result = await dispatcher.dispatchAll(baseJob, ['Unknown:foo']);
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].error, 'r0_action_not_implemented');
});

test('missing organ_url_key returns organ_url_missing', async () => {
  const table = { actions: { 'X:q': { organ_url_key: 'xUrl', method: 'GET', path: '/q', body_template: null } } };
  const dispatcher = createR0Dispatcher({ endpointsTable: table, organUrls: {}, timeoutMs: 2000 });
  const result = await dispatcher.dispatchAll(baseJob, ['X:q']);
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].error, 'organ_url_missing');
});

test('HTTP failure for one target goes to failures, others in results', async () => {
  let callCount = 0;
  const fake = await createFakeOrganServer((req, res) => {
    callCount++;
    if (callCount === 1) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true}'); }
    else { res.writeHead(500).end(); }
  });
  try {
    const table = {
      actions: {
        'A:q': { organ_url_key: 'u', method: 'GET', path: '/a', body_template: null },
        'B:q': { organ_url_key: 'u', method: 'GET', path: '/b', body_template: null },
      },
    };
    const dispatcher = createR0Dispatcher({ endpointsTable: table, organUrls: { u: fake.url }, timeoutMs: 2000 });
    const result = await dispatcher.dispatchAll(baseJob, ['A:q', 'B:q']);
    assert.equal(result.results.length + result.failures.length, 2);
  } finally { await fake.close(); }
});

test('resolveTemplate substitutes $.description correctly', async () => {
  const fake = await createFakeOrganServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ received: JSON.parse(body) }));
  });
  try {
    const table = { actions: { 'R:q': { organ_url_key: 'u', method: 'POST', path: '/q', body_template: { query: '$.description' } } } };
    const dispatcher = createR0Dispatcher({ endpointsTable: table, organUrls: { u: fake.url }, timeoutMs: 2000 });
    const result = await dispatcher.dispatchOne('R:q', { ...baseJob, description: 'find backups' });
    assert.equal(result.ok, true);
    assert.equal(result.data.received.query, 'find backups');
  } finally { await fake.close(); }
});

test('loadR0EndpointsTable returns parsed table on valid file', async () => {
  const realPath = join(__dirname, '..', 'config', 'r0-action-endpoints.json');
  const table = await loadR0EndpointsTable(realPath);
  assert.ok(table.actions);
  assert.ok(Object.keys(table.actions).length > 10);
});

test('loadR0EndpointsTable returns empty actions on missing file', async () => {
  const table = await loadR0EndpointsTable('/nonexistent/path.json');
  assert.deepEqual(table.actions, {});
});
