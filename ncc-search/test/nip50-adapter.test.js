import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Nip50Adapter } from '../src/adapters/nip50.js';
import { SERVICE_RECORD_KIND } from '../src/discovery.js';
import { KIND_ROOT_SITE, KIND_NAMED_SITE } from '../src/adapters/nsite.js';

function fakeConfig(overrides = {}) {
  return { relays: ['wss://relay.example'], fetchTimeoutMs: 1000, ...overrides };
}

function fakePool(events) {
  return { querySync: async () => events };
}

function stubCrawler() {
  const ingested = [];
  return { ingested, ingestEvent: (event) => ingested.push(event) };
}

function nccEvent({ id = 'e1', pubkey = 'a'.repeat(64), dTag = 'web', title, description } = {}) {
  const tags = [['d', dTag]];
  if (title) tags.push(['title', title]);
  if (description) tags.push(['description', description]);
  return { id, kind: SERVICE_RECORD_KIND, pubkey, tags, content: '', created_at: 0 };
}

function nsiteEvent({ id = 'e2', pubkey = 'b'.repeat(64), kind = KIND_NAMED_SITE, dTag = 'blog' } = {}) {
  const tags = kind === KIND_NAMED_SITE ? [['d', dTag]] : [];
  return { id, kind, pubkey, tags, content: '', created_at: 0 };
}

test('search() short-circuits to [] when no configured relay advertises NIP-50', async () => {
  const adapter = new Nip50Adapter(fakePool([nccEvent()]), fakeConfig());
  adapter.prober = { filterCapable: async () => [] }; // no relay supports NIP-50

  const hits = await adapter.search('wallet');
  assert.deepEqual(hits, []);
});

test('search() maps an NCC-02 service record to a live hit and ingests it into the NCC crawler', async () => {
  const event = nccEvent({ title: 'My Wallet', description: 'self-hosted wallet' });
  const nccCrawler = stubCrawler();
  const nsiteCrawler = stubCrawler();
  const adapter = new Nip50Adapter(fakePool([event]), fakeConfig(), { nccCrawler, nsiteCrawler });
  adapter.prober = { filterCapable: async (relays) => relays };

  const hits = await adapter.search('wallet');

  assert.equal(hits.length, 1);
  assert.deepEqual(hits[0], {
    pubkey: event.pubkey,
    kind: 'ncc-service',
    itemId: 'web',
    title: 'My Wallet',
    description: 'self-hosted wallet',
    eventId: 'e1',
    source: 'live',
  });
  assert.equal(nccCrawler.ingested.length, 1);
  assert.equal(nccCrawler.ingested[0], event);
  assert.equal(nsiteCrawler.ingested.length, 0, 'nsite crawler must not see an NCC event');
});

test('search() maps a root nsite to itemId "_root" and ingests it into the nsite crawler', async () => {
  const event = nsiteEvent({ kind: KIND_ROOT_SITE });
  const nccCrawler = stubCrawler();
  const nsiteCrawler = stubCrawler();
  const adapter = new Nip50Adapter(fakePool([event]), fakeConfig(), { nccCrawler, nsiteCrawler });
  adapter.prober = { filterCapable: async (relays) => relays };

  const hits = await adapter.search('blog');

  assert.equal(hits[0].kind, 'nsite-root');
  assert.equal(hits[0].itemId, '_root');
  assert.equal(nsiteCrawler.ingested.length, 1);
  assert.equal(nccCrawler.ingested.length, 0, 'ncc crawler must not see an nsite event');
});

test('search() maps a named nsite to its d-tag itemId', async () => {
  const event = nsiteEvent({ kind: KIND_NAMED_SITE, dTag: 'blog' });
  const adapter = new Nip50Adapter(fakePool([event]), fakeConfig());
  adapter.prober = { filterCapable: async (relays) => relays };

  const hits = await adapter.search('blog');
  assert.equal(hits[0].kind, 'nsite-named');
  assert.equal(hits[0].itemId, 'blog');
});

test('search() discards events of kinds outside the NCC/nsite set, even if a lenient relay returns them', async () => {
  const offKind = { id: 'e3', kind: 1, pubkey: 'c'.repeat(64), tags: [], content: 'just a note', created_at: 0 };
  const adapter = new Nip50Adapter(fakePool([offKind]), fakeConfig());
  adapter.prober = { filterCapable: async (relays) => relays };

  const hits = await adapter.search('anything');
  assert.deepEqual(hits, []);
});

test('search() resolves to [] rather than hanging if querySync never returns within the timeout', async () => {
  const neverResolves = { querySync: () => new Promise(() => {}) };
  const adapter = new Nip50Adapter(neverResolves, fakeConfig({ fetchTimeoutMs: 20 }));
  adapter.prober = { filterCapable: async (relays) => relays };

  const start = Date.now();
  const hits = await adapter.search('anything');
  const elapsed = Date.now() - start;

  assert.deepEqual(hits, []);
  assert.ok(elapsed < 1000, `expected the timeout race to resolve quickly, took ${elapsed}ms`);
});
