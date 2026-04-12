import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createGraphAdapter, GraphTimeoutError } from '../lib/graph-adapter.js';

function createFakeGraphServer(handler) {
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    handler(req, res, body ? JSON.parse(body) : null);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}`,
        server,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

test('queryConcepts sends POST to /query with sql and params', async () => {
  const fake = await createFakeGraphServer((req, res, body) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ rows: [{ urn: 'urn:test', data: {} }], count: 1 }));
  });
  try {
    const adapter = createGraphAdapter({ graphUrl: fake.url, timeoutMs: 2000 });
    const result = await adapter.queryConcepts('SELECT * FROM concepts', []);
    assert.equal(result.rows.length, 1);
  } finally { await fake.close(); }
});

test('getConcept returns data on 200', async () => {
  const concept = { urn: 'urn:test:1', data: { type: 'test' } };
  const fake = await createFakeGraphServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(concept));
  });
  try {
    const adapter = createGraphAdapter({ graphUrl: fake.url, timeoutMs: 2000 });
    const result = await adapter.getConcept('urn:test:1');
    assert.deepEqual(result, concept);
  } finally { await fake.close(); }
});

test('getConcept returns null on 404', async () => {
  const fake = await createFakeGraphServer((req, res) => {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'NOT_FOUND' }));
  });
  try {
    const adapter = createGraphAdapter({ graphUrl: fake.url, timeoutMs: 2000 });
    const result = await adapter.getConcept('urn:test:missing');
    assert.equal(result, null);
  } finally { await fake.close(); }
});

test('queryConcepts throws on non-ok response', async () => {
  const fake = await createFakeGraphServer((req, res) => {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'INTERNAL' }));
  });
  try {
    const adapter = createGraphAdapter({ graphUrl: fake.url, timeoutMs: 2000 });
    await assert.rejects(
      () => adapter.queryConcepts('SELECT 1', []),
      /graph_query_failed/,
    );
  } finally { await fake.close(); }
});

test('queryConcepts throws GraphTimeoutError on timeout', async () => {
  const fake = await createFakeGraphServer(() => { /* hang */ });
  try {
    const adapter = createGraphAdapter({ graphUrl: fake.url, timeoutMs: 50 });
    await assert.rejects(
      () => adapter.queryConcepts('SELECT 1', []),
      (err) => err instanceof GraphTimeoutError,
    );
  } finally { await fake.close(); }
});

test('X-Organ-Name header is Thalamus', async () => {
  let capturedHeaders;
  const fake = await createFakeGraphServer((req, res) => {
    capturedHeaders = req.headers;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ rows: [], count: 0 }));
  });
  try {
    const adapter = createGraphAdapter({ graphUrl: fake.url, timeoutMs: 2000 });
    await adapter.queryConcepts('SELECT 1', []);
    assert.equal(capturedHeaders['x-organ-name'], 'Thalamus');
  } finally { await fake.close(); }
});
