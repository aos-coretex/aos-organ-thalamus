import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createArbiterClient } from '../lib/arbiter-client.js';

function createFakeArbiter(handler) {
  const server = http.createServer((req, res) => handler(req, res));
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

const sampleBor = {
  version: '1.0.0',
  hash: '987fedcba',
  raw_text: '# Bill of Rights',
  effective_since: '2026-04-01T00:00:00Z',
  loaded_at: '2026-04-11T00:00:00Z',
};

test('getBoRRaw returns BoR data on 200', async () => {
  const fake = await createFakeArbiter((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(sampleBor));
  });
  try {
    const client = createArbiterClient({ arbiterUrl: fake.url, timeoutMs: 2000 });
    const bor = await client.getBoRRaw();
    assert.equal(bor.version, '1.0.0');
    assert.equal(bor.raw_text, '# Bill of Rights');
  } finally { await fake.close(); }
});

test('getBoRRaw returns null on 503', async () => {
  const fake = await createFakeArbiter((req, res) => {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'BOR_NOT_LOADED' }));
  });
  try {
    const client = createArbiterClient({ arbiterUrl: fake.url, timeoutMs: 2000 });
    const bor = await client.getBoRRaw();
    assert.equal(bor, null);
  } finally { await fake.close(); }
});

test('getBoRRaw returns null on 404', async () => {
  const fake = await createFakeArbiter((req, res) => {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'NOT_FOUND' }));
  });
  try {
    const client = createArbiterClient({ arbiterUrl: fake.url, timeoutMs: 2000 });
    const bor = await client.getBoRRaw();
    assert.equal(bor, null);
  } finally { await fake.close(); }
});

test('getBoRRaw returns null on timeout', async () => {
  const fake = await createFakeArbiter(() => { /* hang */ });
  try {
    const client = createArbiterClient({ arbiterUrl: fake.url, timeoutMs: 50 });
    const bor = await client.getBoRRaw();
    assert.equal(bor, null);
  } finally { await fake.close(); }
});

test('X-Organ-Name header is Thalamus', async () => {
  let capturedHeaders;
  const fake = await createFakeArbiter((req, res) => {
    capturedHeaders = req.headers;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(sampleBor));
  });
  try {
    const client = createArbiterClient({ arbiterUrl: fake.url, timeoutMs: 2000 });
    await client.getBoRRaw();
    assert.equal(capturedHeaders['x-organ-name'], 'Thalamus');
  } finally { await fake.close(); }
});
