import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createCrawlerClient, createIngestForwarder } from '../src/crawlerClient.js';

async function fakeCrawler(handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const parsed = body ? JSON.parse(body) : null;
      requests.push({ method: req.method, url: req.url, body: parsed });
      handler(req, res, parsed);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test('createCrawlerClient reads the crawler health snapshot', async () => {
  const crawler = await fakeCrawler((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ crawlers: { nsites: { state: 'healthy' } }, relayLearning: { enabled: true } }));
  });

  try {
    const client = createCrawlerClient({ baseUrl: crawler.baseUrl });
    const status = await client.status();

    assert.equal(status.crawlers.nsites.state, 'healthy');
    assert.equal(status.relayLearning.enabled, true);
    assert.equal(crawler.requests[0].url, '/internal/status');
  } finally {
    await crawler.close();
  }
});

test('createCrawlerClient degrades to null when the crawler is unreachable or erroring', async () => {
  const crawler = await fakeCrawler((req, res) => { res.statusCode = 503; res.end('nope'); });

  try {
    const client = createCrawlerClient({ baseUrl: crawler.baseUrl });
    assert.equal(await client.status(), null);
  } finally {
    await crawler.close();
  }

  // Port just closed: also the "crawler restarting" path.
  const client = createCrawlerClient({ baseUrl: 'http://127.0.0.1:1', timeoutMs: 200 });
  assert.equal(await client.status(), null);
  assert.equal(await client.ingest({ kind: 30059 }), false);
});

test('createCrawlerClient posts an event to the crawler ingest endpoint', async () => {
  const crawler = await fakeCrawler((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ingested: true }));
  });

  try {
    const client = createCrawlerClient({ baseUrl: crawler.baseUrl });
    const event = { kind: 30059, pubkey: 'd'.repeat(64), created_at: 1, tags: [['d', 'web']], content: '' };

    assert.equal(await client.ingest(event), true);
    assert.equal(crawler.requests[0].method, 'POST');
    assert.equal(crawler.requests[0].url, '/internal/ingest');
    assert.deepEqual(crawler.requests[0].body.event, event);
  } finally {
    await crawler.close();
  }
});

// Nip50Adapter calls one ingest method per content type; in the split
// deployment every one of them has to reach the same crawler endpoint,
// which re-routes by kind (see ingest.js).
test('createIngestForwarder maps every adapter ingest entry point onto the client', () => {
  const posted = [];
  const forwarder = createIngestForwarder({ ingest: (event) => { posted.push(event.kind); return Promise.resolve(true); } });

  forwarder.nccCrawler.ingestEvent({ kind: 30059 });
  forwarder.nsiteCrawler.ingestEvent({ kind: 35128 });
  forwarder.contentCrawler.ingestArticle({ kind: 30023 });
  forwarder.contentCrawler.ingestMedia({ kind: 20 });

  assert.deepEqual(posted, [30059, 35128, 30023, 20]);
});
