import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../src/server.js';

function fakeStore(indexResults) {
  return {
    search: () => indexResults,
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
