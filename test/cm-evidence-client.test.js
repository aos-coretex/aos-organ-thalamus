import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createCmEvidenceClient } from '../lib/cm-evidence-client.js';

function createFakeServer(routes) {
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const handler = routes[req.url] || routes['*'];
    if (handler) {
      handler(req, res, body ? JSON.parse(body) : null);
    } else {
      res.writeHead(404).end();
    }
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

test('cortex_goal: gathers evidence_refs passthrough + Radiant query', async () => {
  const fake = await createFakeServer({
    '/query': (req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ blocks: [{ content: 'backup info', urn: 'urn:r:1' }] }));
    },
  });
  try {
    const client = createCmEvidenceClient({
      radiantUrl: fake.url, minderUrl: fake.url, hippocampusUrl: fake.url, syntraUrl: fake.url,
      timeoutMs: 2000,
    });
    const result = await client.gather({
      description: 'backups stale',
      evidence_refs: ['urn:existing:1'],
      intake_context: { kind: 'cortex_goal' },
    });
    assert.ok(result.evidence.length >= 2); // 1 passthrough + 1 from Radiant
    assert.ok(result.evidence.some(e => e.source === 'cortex_passthrough'));
    assert.ok(result.evidence.some(e => e.source === 'Radiant'));
    assert.deepEqual(result.degraded, []);
  } finally { await fake.close(); }
});

test('cortex_goal: Radiant failure adds degraded flag but does not fail', async () => {
  const fake = await createFakeServer({
    '/query': (req, res) => { res.writeHead(500).end(); },
  });
  try {
    const client = createCmEvidenceClient({
      radiantUrl: fake.url, minderUrl: fake.url, hippocampusUrl: fake.url, syntraUrl: fake.url,
      timeoutMs: 2000,
    });
    const result = await client.gather({
      description: 'test', evidence_refs: [], intake_context: { kind: 'cortex_goal' },
    });
    assert.ok(result.degraded.includes('radiant-degraded'));
  } finally { await fake.close(); }
});

test('receptor_request: gathers from Minder + Hippocampus + Syntra', async () => {
  const fake = await createFakeServer({
    '*': (req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (req.url.includes('/observations')) {
        res.end(JSON.stringify({ observations: [{ content: 'Leon prefers functional', urn: 'urn:m:1' }] }));
      } else if (req.url.includes('/recent')) {
        res.end(JSON.stringify({ summaries: [{ summary: 'Discussed backups', urn: 'urn:h:1' }] }));
      } else if (req.url === '/search') {
        res.end(JSON.stringify({ results: [{ text: 'relevant doc', urn: 'urn:s:1' }] }));
      } else {
        res.end('{}');
      }
    },
  });
  try {
    const client = createCmEvidenceClient({
      radiantUrl: fake.url, minderUrl: fake.url, hippocampusUrl: fake.url, syntraUrl: fake.url,
      timeoutMs: 2000,
    });
    const result = await client.gather({
      description: 'question about backups',
      evidence_refs: [],
      intake_context: {
        kind: 'receptor_request',
        user_identity: 'urn:llm-ops:user:leon',
        session_id: 'urn:llm-ops:session:1',
        intent_label: 'question',
      },
    });
    assert.ok(result.evidence.some(e => e.source === 'Minder'));
    assert.ok(result.evidence.some(e => e.source === 'Hippocampus'));
    assert.ok(result.evidence.some(e => e.source === 'Syntra'));
    assert.deepEqual(result.degraded, []);
  } finally { await fake.close(); }
});

test('receptor_request: partial failure (Minder down)', async () => {
  const fake = await createFakeServer({
    '*': (req, res) => {
      if (req.url.includes('/observations')) {
        res.writeHead(500).end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (req.url.includes('/recent')) {
        res.end(JSON.stringify({ summaries: [] }));
      } else {
        res.end(JSON.stringify({ results: [] }));
      }
    },
  });
  try {
    const client = createCmEvidenceClient({
      radiantUrl: fake.url, minderUrl: fake.url, hippocampusUrl: fake.url, syntraUrl: fake.url,
      timeoutMs: 2000,
    });
    const result = await client.gather({
      description: 'test', evidence_refs: [],
      intake_context: { kind: 'receptor_request', user_identity: 'urn:u:1', session_id: 's1', intent_label: 'q' },
    });
    assert.ok(result.degraded.includes('minder-degraded'));
  } finally { await fake.close(); }
});

test('unknown intake kind returns degraded flag', async () => {
  const client = createCmEvidenceClient({
    radiantUrl: 'http://nope', minderUrl: 'http://nope', hippocampusUrl: 'http://nope', syntraUrl: 'http://nope',
  });
  const result = await client.gather({ intake_context: { kind: 'alien' } });
  assert.deepEqual(result.evidence, []);
  assert.ok(result.degraded.includes('unknown-intake-kind'));
});
