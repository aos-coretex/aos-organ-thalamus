import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createSpineStateClient, SpineStateError } from '../lib/spine-state-client.js';

// Start a fake spine-state HTTP server on a random port.
// Returns { url, server, close(), requests[] }.
function createFakeServer(handler) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const parsed = body ? JSON.parse(body) : null;
    requests.push({ method: req.method, url: req.url, body: parsed, headers: req.headers });
    handler(req, res, parsed);
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}`,
        server,
        requests,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

test('createJobEntity POSTs the right body to /entities', async () => {
  const fake = await createFakeServer((req, res, body) => {
    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ entity_urn: body.entity_urn, state: 'CREATED' }));
  });

  try {
    const client = createSpineStateClient({ spineUrl: fake.url, timeoutMs: 2000 });
    const result = await client.createJobEntity('urn:llm-ops:job:test-1', { source: 'cortex' });

    assert.equal(fake.requests.length, 1);
    assert.equal(fake.requests[0].method, 'POST');
    assert.equal(fake.requests[0].url, '/entities');
    assert.equal(fake.requests[0].body.entity_urn, 'urn:llm-ops:job:test-1');
    assert.equal(fake.requests[0].body.entity_type, 'job');
    assert.deepEqual(fake.requests[0].body.metadata, { source: 'cortex' });
    assert.equal(result.entity_urn, 'urn:llm-ops:job:test-1');
  } finally {
    await fake.close();
  }
});

test('transitionJob URL-encodes the URN and POSTs the right body', async () => {
  const fake = await createFakeServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ entity_urn: 'urn:llm-ops:job:test-1', from_state: 'CREATED', to_state: 'PLANNING' }));
  });

  try {
    const client = createSpineStateClient({ spineUrl: fake.url, timeoutMs: 2000 });
    await client.transitionJob('urn:llm-ops:job:test-1', 'CREATED', 'PLANNING', 'test-reason');

    assert.equal(fake.requests.length, 1);
    assert.equal(fake.requests[0].method, 'POST');
    // URL should contain the encoded URN
    assert.ok(fake.requests[0].url.includes(encodeURIComponent('urn:llm-ops:job:test-1')));
    assert.ok(fake.requests[0].url.endsWith('/transition'));
    assert.equal(fake.requests[0].body.from_state, 'CREATED');
    assert.equal(fake.requests[0].body.to_state, 'PLANNING');
    assert.equal(fake.requests[0].body.reason, 'test-reason');
    assert.equal(fake.requests[0].body.actor, 'Thalamus');
  } finally {
    await fake.close();
  }
});

test('getJobEntity returns null on 404', async () => {
  const fake = await createFakeServer((req, res) => {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'ENTITY_NOT_FOUND' }));
  });

  try {
    const client = createSpineStateClient({ spineUrl: fake.url, timeoutMs: 2000 });
    const result = await client.getJobEntity('urn:llm-ops:job:nonexistent');
    assert.equal(result, null);
  } finally {
    await fake.close();
  }
});

test('getJobEntity returns the body on 200', async () => {
  const entity = { entity_urn: 'urn:llm-ops:job:test-1', state: 'PLANNING', transitions: [] };
  const fake = await createFakeServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(entity));
  });

  try {
    const client = createSpineStateClient({ spineUrl: fake.url, timeoutMs: 2000 });
    const result = await client.getJobEntity('urn:llm-ops:job:test-1');
    assert.deepEqual(result, entity);
  } finally {
    await fake.close();
  }
});

test('SpineStateError is thrown with the right shape on 4xx/5xx', async () => {
  const fake = await createFakeServer((req, res) => {
    res.writeHead(409, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'ENTITY_EXISTS' }));
  });

  try {
    const client = createSpineStateClient({ spineUrl: fake.url, timeoutMs: 2000 });
    await assert.rejects(
      () => client.createJobEntity('urn:llm-ops:job:dup', {}),
      (err) => {
        assert.ok(err instanceof SpineStateError);
        assert.equal(err.name, 'SpineStateError');
        assert.equal(err.op, 'create_entity');
        assert.equal(err.status, 409);
        return true;
      },
    );
  } finally {
    await fake.close();
  }
});

test('SpineStateError on 500 from transition', async () => {
  const fake = await createFakeServer((req, res) => {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'INTERNAL_ERROR' }));
  });

  try {
    const client = createSpineStateClient({ spineUrl: fake.url, timeoutMs: 2000 });
    await assert.rejects(
      () => client.transitionJob('urn:llm-ops:job:x', 'CREATED', 'PLANNING', 'reason'),
      (err) => {
        assert.ok(err instanceof SpineStateError);
        assert.equal(err.op, 'transition');
        assert.equal(err.status, 500);
        return true;
      },
    );
  } finally {
    await fake.close();
  }
});

test('timedFetch aborts on timeout', async () => {
  // Fake server that hangs indefinitely
  const fake = await createFakeServer((req, res) => {
    // Intentionally never respond — simulate a hung server
  });

  try {
    const client = createSpineStateClient({ spineUrl: fake.url, timeoutMs: 50 });
    await assert.rejects(
      () => client.createJobEntity('urn:llm-ops:job:timeout', {}),
      (err) => {
        assert.ok(err instanceof SpineStateError);
        assert.equal(err.status, 0);
        assert.ok(err.detail === 'timeout' || err.message.includes('timeout'));
        return true;
      },
    );
  } finally {
    await fake.close();
  }
});

test('X-Organ-Name header is set to Thalamus', async () => {
  const fake = await createFakeServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ entity_urn: 'x', state: 'PLANNING' }));
  });

  try {
    const client = createSpineStateClient({ spineUrl: fake.url, timeoutMs: 2000 });
    await client.getJobEntity('urn:llm-ops:job:header-test');
    assert.equal(fake.requests[0].headers['x-organ-name'], 'Thalamus');
  } finally {
    await fake.close();
  }
});
