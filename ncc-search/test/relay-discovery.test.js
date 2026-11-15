import { test } from 'node:test';
import assert from 'node:assert/strict';
import { subscribeRelayWithBackoff } from '../src/relayDiscovery.js';

test('relay discovery resumes with overlap and saves a cursor after EOSE', () => {
  const calls = [];
  let savedCursor = 0;
  const store = {
    getDiscoveryCursor: () => 10_000,
    saveDiscoveryCursor: (_source, _relay, cursor) => { savedCursor = cursor; },
  };
  const pool = {
    subscribeMany(relays, filter, handlers) {
      calls.push({ relays, filter, handlers });
      return { close() {} };
    },
  };
  const monitor = { connecting() {}, event() {}, eose() {}, failed() {}, processingFailed() {} };

  const subscription = subscribeRelayWithBackoff(
    pool,
    'wss://relay.example',
    'articles',
    { kinds: [30023] },
    () => {},
    { store, monitor },
  );
  try {
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].relays, ['wss://relay.example']);
    assert.equal(calls[0].filter.since, 9_700, 'resume includes a five-minute overlap');
    calls[0].handlers.oneose();
    assert.ok(savedCursor > 10_000, 'successful EOSE advances the persistent cursor');
  } finally {
    subscription.close();
  }
});
