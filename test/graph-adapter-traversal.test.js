import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createGraphAdapter } from '../lib/graph-adapter.js';

// Fake Graph server that responds to POST /query and GET /concepts/:urn
function createFakeGraphServer({ concepts = {}, bindingRows = [] } = {}) {
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const parsed = body ? JSON.parse(body) : null;

    if (req.method === 'POST' && req.url === '/query') {
      // SQL query — return bindingRows if querying class_bindings, else return matching concepts
      const sql = parsed?.sql || '';
      if (sql.includes('class_bindings')) {
        const urn = parsed?.params?.[0];
        const matching = bindingRows.filter(b => {
          const d = typeof b.data === 'string' ? JSON.parse(b.data) : b.data;
          return d.from_urn === urn || d.to_urn === urn;
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ rows: matching, count: matching.length }));
      } else if (sql.includes('concepts')) {
        const type = parsed?.params?.[0];
        const limit = parsed?.params?.[1] || 20;
        const matching = Object.values(concepts).filter(c => {
          const d = typeof c.data === 'string' ? JSON.parse(c.data) : c.data;
          return d?.type === type;
        }).slice(0, limit);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ rows: matching, count: matching.length }));
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ rows: [], count: 0 }));
      }
      return;
    }

    if (req.method === 'GET' && req.url.startsWith('/concepts/')) {
      const urn = decodeURIComponent(req.url.replace('/concepts/', ''));
      if (concepts[urn]) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(concepts[urn]));
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'NOT_FOUND' }));
      }
      return;
    }

    res.writeHead(404).end();
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

test('getBindings returns bindings via POST /query SQL', async () => {
  const fake = await createFakeGraphServer({
    bindingRows: [
      { ubn: 'ubn:1', data: { from_urn: 'urn:a', to_urn: 'urn:b', relation: 'linked' } },
      { ubn: 'ubn:2', data: { from_urn: 'urn:c', to_urn: 'urn:a', relation: 'ref' } },
    ],
  });
  try {
    const adapter = createGraphAdapter({ graphUrl: fake.url, timeoutMs: 2000 });
    const result = await adapter.getBindings('urn:a');
    assert.equal(result.bindings.length, 2);
    assert.deepEqual(result.degraded, []);
  } finally { await fake.close(); }
});

test('getBindings returns empty array when no bindings match', async () => {
  const fake = await createFakeGraphServer({ bindingRows: [] });
  try {
    const adapter = createGraphAdapter({ graphUrl: fake.url, timeoutMs: 2000 });
    const result = await adapter.getBindings('urn:nomatch');
    assert.equal(result.bindings.length, 0);
  } finally { await fake.close(); }
});

test('getBindings returns degraded on HTTP error', async () => {
  const server = http.createServer((req, res) => { res.writeHead(500).end(); });
  const fake = await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) });
    });
  });
  try {
    const adapter = createGraphAdapter({ graphUrl: fake.url, timeoutMs: 2000 });
    const result = await adapter.getBindings('urn:x');
    assert.ok(result.degraded.includes('graph-bindings-query-failed'));
  } finally { await fake.close(); }
});

test('traverseFrom single-hop returns seed + direct bindings', async () => {
  const fake = await createFakeGraphServer({
    concepts: {
      'urn:a': { urn: 'urn:a', data: { type: 'test' } },
      'urn:b': { urn: 'urn:b', data: { type: 'test' } },
    },
    bindingRows: [
      { ubn: 'ubn:1', data: { from_urn: 'urn:a', to_urn: 'urn:b' } },
    ],
  });
  try {
    const adapter = createGraphAdapter({ graphUrl: fake.url, timeoutMs: 2000 });
    const result = await adapter.traverseFrom('urn:a', { depth: 1 });
    assert.ok(result.entities.some(e => e.urn === 'urn:a'));
    assert.ok(result.entities.some(e => e.urn === 'urn:b'));
    assert.equal(result.bindings.length, 1);
  } finally { await fake.close(); }
});

test('traverseFrom depth cap at 3', async () => {
  const fake = await createFakeGraphServer({
    concepts: { 'urn:a': { urn: 'urn:a', data: {} } },
    bindingRows: [],
  });
  try {
    const adapter = createGraphAdapter({ graphUrl: fake.url, timeoutMs: 2000 });
    const result = await adapter.traverseFrom('urn:a', { depth: 5 });
    assert.equal(result.depth_reached, 3, 'depth should be capped at 3');
  } finally { await fake.close(); }
});

test('traverseFrom cycle detection — does not revisit URNs', async () => {
  // A -> B -> A cycle
  const fake = await createFakeGraphServer({
    concepts: {
      'urn:a': { urn: 'urn:a', data: {} },
      'urn:b': { urn: 'urn:b', data: {} },
    },
    bindingRows: [
      { ubn: 'ubn:1', data: { from_urn: 'urn:a', to_urn: 'urn:b' } },
      { ubn: 'ubn:2', data: { from_urn: 'urn:b', to_urn: 'urn:a' } },
    ],
  });
  try {
    const adapter = createGraphAdapter({ graphUrl: fake.url, timeoutMs: 2000 });
    const result = await adapter.traverseFrom('urn:a', { depth: 3 });
    // Each entity visited exactly once
    const urns = result.entities.map(e => e.urn);
    assert.equal(new Set(urns).size, urns.length, 'no duplicate entities');
    assert.equal(urns.length, 2);
  } finally { await fake.close(); }
});

test('traverseFrom limit cap', async () => {
  const concepts = {};
  for (let i = 0; i < 10; i++) concepts[`urn:${i}`] = { urn: `urn:${i}`, data: {} };
  const fake = await createFakeGraphServer({ concepts, bindingRows: [] });
  try {
    const adapter = createGraphAdapter({ graphUrl: fake.url, timeoutMs: 2000 });
    // Only seed is urn:0, with no bindings it visits just 1
    const result = await adapter.traverseFrom('urn:0', { depth: 1, limit: 5 });
    assert.ok(result.entities.length <= 5);
  } finally { await fake.close(); }
});

test('getConceptsByType returns matching concepts', async () => {
  const fake = await createFakeGraphServer({
    concepts: {
      'urn:msp:1': { urn: 'urn:msp:1', data: { type: 'msp_version' } },
      'urn:other:1': { urn: 'urn:other:1', data: { type: 'other' } },
    },
  });
  try {
    const adapter = createGraphAdapter({ graphUrl: fake.url, timeoutMs: 2000 });
    const result = await adapter.getConceptsByType('msp_version', 5);
    assert.ok(result.concepts.length >= 1);
    assert.deepEqual(result.degraded, []);
  } finally { await fake.close(); }
});

test('getConceptsByType returns degraded on error', async () => {
  const server = http.createServer((req, res) => { res.writeHead(500).end(); });
  const fake = await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) });
    });
  });
  try {
    const adapter = createGraphAdapter({ graphUrl: fake.url, timeoutMs: 2000 });
    const result = await adapter.getConceptsByType('test', 5);
    assert.ok(result.degraded.includes('graph-concepts-by-type-failed'));
  } finally { await fake.close(); }
});
