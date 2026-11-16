import { test } from 'node:test';
import assert from 'node:assert/strict';
import { finalizeEvent, generateSecretKey } from 'nostr-tools';
import { parseReadRelays, safeRelayUrl, startRelayLearning } from '../src/relayLearning.js';
import { createRelayRegistry } from '../src/relayDiscovery.js';

test('NIP-65 parsing keeps read and unmarked entries and rejects unsafe relay URLs', () => {
  const event = { tags: [
    ['r', 'wss://read.example'],
    ['r', 'wss://both.example', 'read'],
    ['r', 'wss://write.example', 'write'],
    ['r', 'ws://insecure.example'],
    ['r', 'wss://127.0.0.1'],
    ['r', 'wss://read.example'],
  ] };
  assert.deepEqual(parseReadRelays(event), ['wss://read.example/', 'wss://both.example/']);
  assert.equal(safeRelayUrl('wss://localhost'), null);
  assert.equal(safeRelayUrl('wss://[::1]'), null);
  assert.equal(safeRelayUrl('wss://user:pass@relay.example'), null);
});

test('relay registry adds and removes promoted relays across active subscriptions', () => {
  const registry = createRelayRegistry(['wss://bootstrap.example']);
  const active = new Set();
  const add = (url) => active.add(url);
  add.remove = (url) => active.delete(url);
  registry.register(add);
  registry.add('wss://learned.example');
  assert.deepEqual([...active].sort(), ['wss://bootstrap.example', 'wss://learned.example']);
  registry.remove('wss://learned.example');
  assert.deepEqual([...active], ['wss://bootstrap.example']);
  assert.ok(registry.allKnown().includes('wss://learned.example'));
});

test('three distinct indexed authors promote a reachable relay', async () => {
  const eventsByPubkey = new Map();
  for (let i = 0; i < 3; i++) {
    const secret = generateSecretKey();
    const event = finalizeEvent({ kind: 10002, created_at: 10 + i, tags: [['r', 'wss://community.example']], content: '' }, secret);
    eventsByPubkey.set(event.pubkey, event);
  }
  const checked = new Set();
  const lists = new Map();
  const savedLearned = new Set();
  const store = {
    listLearnedRelays: () => [],
    listRelayCandidateProbes: () => [],
    listNip65AuthorsToCheck: () => [...eventsByPubkey.keys()].filter((key) => !checked.has(key)).slice(0, 5),
    saveNip65RelayList: (key, createdAt, relays) => lists.set(key, { createdAt, relays }),
    markNip65AuthorChecked: (key) => checked.add(key),
    listNip65RelayCandidates: () => {
      const authors = new Set();
      for (const [key, row] of lists) if (row.relays.includes('wss://community.example/')) authors.add(key);
      return [{ url: 'wss://community.example/', authorCount: authors.size }];
    },
    saveLearnedRelay: (url) => savedLearned.add(url),
    recordLearnedRelayProbe() {},
    recordRelayCandidateProbe() {},
    removeLearnedRelay: (url) => savedLearned.delete(url),
  };
  const pool = {
    async querySync(relays, filter) {
      if (filter.authors) return [eventsByPubkey.get(filter.authors[0])];
      return [];
    },
  };
  const registry = createRelayRegistry(['wss://bootstrap.example']);
  const learning = startRelayLearning({ learnRelays: true, relays: ['wss://bootstrap.example'], tickIntervalMs: 60_000 }, store, pool, registry);
  try {
    for (let i = 0; i < 30 && savedLearned.size === 0; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual([...savedLearned], ['wss://community.example/']);
    assert.ok(registry.all().includes('wss://community.example/'));
    assert.equal(learning.snapshot().learnedCount, 1);
  } finally {
    learning.stop();
  }
});
