import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInternalServer } from '../src/internal.js';
import { SERVICE_RECORD_KIND } from '../src/discovery.js';
import { KIND_ROOT_SITE, KIND_NAMED_SITE } from '../src/adapters/nsite.js';
import { KIND_ARTICLE_EVENT } from '../src/adapters/article.js';
import { KIND_PICTURE } from '../src/adapters/media.js';

function fakeCrawlers() {
  const seen = [];
  const record = (name) => (event) => seen.push([name, event.kind]);
  return {
    seen,
    nccCrawler: { ingestEvent: record('ncc') },
    nsiteCrawler: { ingestEvent: record('nsite') },
    contentCrawler: { ingestArticle: record('article'), ingestMedia: record('media') },
  };
}

function event(kind, extra = {}) {
  return { kind, pubkey: 'c'.repeat(64), created_at: 1_700_000_000, tags: [['d', 'x']], content: '', ...extra };
}

test('POST /internal/ingest routes each kind to the adapter that owns it', async () => {
  const crawlers = fakeCrawlers();
  const app = createInternalServer({ crawlers });

  for (const kind of [SERVICE_RECORD_KIND, KIND_ROOT_SITE, KIND_NAMED_SITE, KIND_ARTICLE_EVENT, KIND_PICTURE]) {
    const res = await app.inject({ method: 'POST', url: '/internal/ingest', payload: { event: event(kind) } });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().ingested, true, `kind ${kind} should be routed`);
  }

  assert.deepEqual(crawlers.seen, [
    ['ncc', SERVICE_RECORD_KIND],
    ['nsite', KIND_ROOT_SITE],
    ['nsite', KIND_NAMED_SITE],
    ['article', KIND_ARTICLE_EVENT],
    ['media', KIND_PICTURE],
  ]);
});

test('POST /internal/ingest reports an unrouted kind instead of failing the request', async () => {
  const app = createInternalServer({ crawlers: fakeCrawlers() });

  // npack (kind:9900) is deliberately not a live-search kind, so nothing owns it.
  const res = await app.inject({ method: 'POST', url: '/internal/ingest', payload: { event: event(9900) } });

  assert.equal(res.statusCode, 200);
  assert.equal(res.json().ingested, false);
});

test('POST /internal/ingest rejects a body that is not a plausible event', async () => {
  const app = createInternalServer({ crawlers: fakeCrawlers() });

  for (const payload of [{}, { event: null }, { event: { kind: 30059 } }, { event: { ...event(30059), tags: 'nope' } }]) {
    const res = await app.inject({ method: 'POST', url: '/internal/ingest', payload });
    assert.equal(res.statusCode, 400, `expected 400 for ${JSON.stringify(payload)}`);
  }
});

test('GET /internal/status carries the in-memory snapshots the API cannot compute itself', async () => {
  const app = createInternalServer({
    crawlers: {},
    crawlMonitor: { snapshot: () => ({ articles: { state: 'healthy', connectedRelays: 2 } }) },
    relayLearning: { snapshot: () => ({ enabled: true, learnedCount: 3 }) },
  });

  const body = (await app.inject({ method: 'GET', url: '/internal/status' })).json();

  assert.equal(body.crawlers.articles.state, 'healthy');
  assert.equal(body.relayLearning.learnedCount, 3);
  assert.equal(typeof body.checkedAt, 'number');
});

test('GET /health answers without touching the crawlers', async () => {
  const app = createInternalServer({});
  const res = await app.inject({ method: 'GET', url: '/health' });

  assert.equal(res.statusCode, 200);
  assert.equal(res.json().ok, true);
});
