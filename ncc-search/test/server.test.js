import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../src/server.js';

function fakeStore(indexResults, calls = []) {
  return {
    search: (_query, limit, offset = 0, sort = 'relevance') => {
      calls.push({ limit, offset, sort });
      return indexResults.slice(offset, offset + limit);
    },
    getService: () => null,
  };
}

test('GET /search returns only index results when no NIP-50 adapter is configured', async () => {
  const store = fakeStore([{ pubkey: 'a', itemId: 'web', title: 'Indexed' }]);
  const app = createServer(store, null);

  const res = await app.inject({ method: 'GET', url: '/search?q=wallet' });
  const body = res.json();

  assert.equal(body.results.length, 1);
  assert.equal(body.results[0].source, 'index');
});

test('GET /status returns aggregate index and crawler status', async () => {
  const store = {
    ...fakeStore([]),
    getStatus: () => ({ recordCount: 7, rowsByKind: { article: 7 }, storage: { databaseBytes: 1234 } }),
  };
  const app = createServer(store, null, {
    crawlMonitor: { snapshot: () => ({ articles: { state: 'healthy', connectedRelays: 2 } }) },
  });

  const res = await app.inject({ method: 'GET', url: '/status' });
  const body = res.json();
  assert.equal(body.ok, true);
  assert.equal(body.index.recordCount, 7);
  assert.equal(body.crawlers.articles.state, 'healthy');
});

// The split deployment has no in-process crawl monitor: health lives in the
// crawler process and is fetched (src/api.js's statusSource).
test('GET /status prefers a remote status source over an in-process monitor', async () => {
  const store = {
    ...fakeStore([]),
    getStatus: () => ({ recordCount: 3, rowsByKind: {}, storage: {} }),
  };
  const app = createServer(store, null, {
    crawlMonitor: { snapshot: () => ({ articles: { state: 'should-not-be-used' } }) },
    statusSource: async () => ({
      crawlers: { nsites: { state: 'degraded', connectedRelays: 1, incomplete: false } },
      relayLearning: { enabled: true, learnedCount: 4 },
    }),
  });

  const body = (await app.inject({ method: 'GET', url: '/status' })).json();
  assert.equal(body.crawlers.nsites.state, 'degraded');
  assert.equal(body.relayLearning.learnedCount, 4);
  assert.equal(body.crawlersUnavailable, false);
});

test('GET /status still serves the index when the crawler process is unreachable', async () => {
  const store = {
    ...fakeStore([]),
    getStatus: () => ({ recordCount: 3, rowsByKind: {}, storage: {} }),
  };
  const app = createServer(store, null, { statusSource: async () => null });

  const res = await app.inject({ method: 'GET', url: '/status' });
  const body = res.json();
  assert.equal(res.statusCode, 200);
  assert.equal(body.index.recordCount, 3);
  assert.deepEqual(body.crawlers, {});
  assert.equal(body.crawlersUnavailable, true);
});

test('GET /search appends live NIP-50 hits that are not already in the index', async () => {
  const store = fakeStore([{ pubkey: 'a', itemId: 'web', title: 'Indexed' }]);
  const nip50Adapter = {
    search: async () => [{ pubkey: 'b', itemId: 'blog', title: 'Live only', source: 'live' }],
  };
  const app = createServer(store, nip50Adapter);

  const res = await app.inject({ method: 'GET', url: '/search?q=wallet' });
  const body = res.json();

  assert.equal(body.results.length, 2);
  assert.equal(body.results[0].source, 'index');
  assert.equal(body.results[1].source, 'live');
});

test('GET /search drops a live hit that duplicates an already-indexed (pubkey, itemId)', async () => {
  const store = fakeStore([{ pubkey: 'a', itemId: 'web', title: 'Indexed, verified' }]);
  const nip50Adapter = {
    search: async () => [
      { pubkey: 'a', itemId: 'web', title: 'Same identity, unverified', source: 'live' },
      { pubkey: 'b', itemId: 'blog', title: 'Genuinely new', source: 'live' },
    ],
  };
  const app = createServer(store, nip50Adapter);

  const res = await app.inject({ method: 'GET', url: '/search?q=wallet' });
  const body = res.json();

  assert.equal(body.results.length, 2, 'the duplicate live hit for (a, web) must be dropped');
  assert.equal(body.results[0].title, 'Indexed, verified', 'the verified index result must win');
  assert.equal(body.results[1].title, 'Genuinely new');
});

test('GET /search drops a live hit that duplicates another live hit for the same (pubkey, itemId)', async () => {
  const store = fakeStore([]);
  const nip50Adapter = {
    search: async () => [
      { pubkey: 'a', itemId: 'web', title: 'Seen on relay one', eventId: 'e1', source: 'live' },
      { pubkey: 'a', itemId: 'web', title: 'Seen on relay two', eventId: 'e2', source: 'live' },
      { pubkey: 'b', itemId: 'blog', title: 'Genuinely different', eventId: 'e3', source: 'live' },
    ],
  };
  const app = createServer(store, nip50Adapter);

  const res = await app.inject({ method: 'GET', url: '/search?q=wallet' });
  const body = res.json();

  assert.equal(body.results.length, 2, 'the two (a, web) hits -- different event ids, same coordinate -- must collapse to one');
  assert.equal(body.results[0].title, 'Seen on relay one', 'the first one seen wins');
  assert.equal(body.results[1].title, 'Genuinely different');
});

test('GET /search?live=false skips the NIP-50 adapter entirely', async () => {
  const store = fakeStore([]);
  let called = false;
  const nip50Adapter = { search: async () => { called = true; return []; } };
  const app = createServer(store, nip50Adapter);

  await app.inject({ method: 'GET', url: '/search?q=wallet&live=false' });
  assert.equal(called, false);
});

test('GET /search without q returns 400', async () => {
  const app = createServer(fakeStore([]), null);
  const res = await app.inject({ method: 'GET', url: '/search' });
  assert.equal(res.statusCode, 400);
});

test('GET /search reports hasMore and pages through offset', async () => {
  const indexResults = Array.from({ length: 5 }, (_, i) => ({ pubkey: `p${i}`, itemId: `item${i}` }));
  const app = createServer(fakeStore(indexResults), null);

  const page1 = (await app.inject({ method: 'GET', url: '/search?q=wallet&limit=2&offset=0' })).json();
  assert.equal(page1.results.length, 2);
  assert.equal(page1.hasMore, true);
  assert.deepEqual(page1.results.map((r) => r.itemId), ['item0', 'item1']);

  const page3 = (await app.inject({ method: 'GET', url: '/search?q=wallet&limit=2&offset=4' })).json();
  assert.equal(page3.results.length, 1);
  assert.equal(page3.hasMore, false, 'nothing left after the last row');
});

test('GET /search skips live NIP-50 hits on pages after the first', async () => {
  const store = fakeStore([{ pubkey: 'a', itemId: 'web' }]);
  let called = false;
  const nip50Adapter = { search: async () => { called = true; return []; } };
  const app = createServer(store, nip50Adapter);

  await app.inject({ method: 'GET', url: '/search?q=wallet&offset=20' });
  assert.equal(called, false, 'a live relay search has no offset of its own to page through');
});

test('GET /search passes a known sort through to the index and echoes it', async () => {
  const calls = [];
  const store = fakeStore([{ pubkey: 'a', itemId: 'web', title: 'Indexed' }], calls);
  const app = createServer(store, null);

  const body = (await app.inject({ method: 'GET', url: '/search?q=wallet&sort=newest' })).json();

  assert.equal(calls[0].sort, 'newest');
  assert.equal(body.sort, 'newest');
});

test('GET /search treats an unknown or absent sort as relevance', async () => {
  const calls = [];
  const store = fakeStore([], calls);
  const app = createServer(store, null);

  await app.inject({ method: 'GET', url: '/search?q=wallet&sort=sideways' });
  await app.inject({ method: 'GET', url: '/search?q=wallet' });

  assert.deepEqual(calls.map((call) => call.sort), ['relevance', 'relevance']);
});

// Live NIP-50 results have no ordering this backend can merge into a date or
// title sort, so mixing them into page 1 would make the sort look ignored.
test('GET /search skips live NIP-50 hits when a non-relevance sort is requested', async () => {
  const store = fakeStore([{ pubkey: 'a', itemId: 'web', title: 'Indexed' }]);
  let liveCalls = 0;
  const nip50Adapter = {
    search: async () => {
      liveCalls += 1;
      return [{ pubkey: 'b', itemId: 'blog', title: 'Live only', source: 'live' }];
    },
  };
  const app = createServer(store, nip50Adapter);

  const body = (await app.inject({ method: 'GET', url: '/search?q=wallet&sort=oldest' })).json();

  assert.equal(liveCalls, 0);
  assert.equal(body.results.length, 1);
  assert.equal(body.results[0].source, 'index');
});
