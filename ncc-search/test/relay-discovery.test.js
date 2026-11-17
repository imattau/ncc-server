import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEventBatch, subscribeRelayWithBackoff } from '../src/relayDiscovery.js';

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

function fakePool() {
  const calls = [];
  return {
    calls,
    subscribeMany(relays, filter, handlers) {
      calls.push({ relays, filter, handlers });
      return { close() {} };
    },
  };
}

const silentMonitor = {
  connecting() {}, event() {}, eose() {}, failed() {}, processingFailed() {},
};

test('relay events are handled asynchronously, in order', async () => {
  const pool = fakePool();
  const seen = [];
  const subscription = subscribeRelayWithBackoff(
    pool,
    'wss://relay.example',
    'profiles',
    { kinds: [0] },
    (event) => seen.push(event.id),
    { monitor: silentMonitor },
  );
  try {
    pool.calls[0].handlers.onevent({ id: 'a' });
    pool.calls[0].handlers.onevent({ id: 'b' });
    assert.deepEqual(seen, [], 'the relay callback must not run the handler inline');
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(seen, ['a', 'b']);
  } finally {
    subscription.close();
  }
});

test('a throwing event handler does not stop later events', async () => {
  const pool = fakePool();
  const seen = [];
  let failed = 0;
  const subscription = subscribeRelayWithBackoff(
    pool,
    'wss://relay.example',
    'articles',
    { kinds: [30023] },
    (event) => {
      if (event.id === 'bad') throw new Error('boom');
      seen.push(event.id);
    },
    { monitor: { ...silentMonitor, processingFailed: () => { failed += 1; } } },
  );
  try {
    for (const id of ['a', 'bad', 'b']) pool.calls[0].handlers.onevent({ id });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(seen, ['a', 'b']);
    assert.equal(failed, 1);
  } finally {
    subscription.close();
  }
});

test('a burst of events yields to the event loop between batches', async () => {
  const seen = [];
  const enqueue = createEventBatch(
    (event) => {
      // Stand in for a synchronous FTS upsert: long enough that the batch
      // budget is exceeded with several events still queued.
      const until = Date.now() + 2;
      while (Date.now() < until) { /* busy */ }
      seen.push(event.id);
    },
    () => {},
    1,
  );

  for (let i = 0; i < 20; i += 1) enqueue({ id: i });

  let handledWhenCheckRan = 0;
  await new Promise((resolve) => {
    setImmediate(() => {
      handledWhenCheckRan = seen.length;
      resolve();
    });
  });

  assert.ok(
    handledWhenCheckRan < 20,
    `the queue must yield before draining everything (handled ${handledWhenCheckRan}/20)`,
  );

  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.deepEqual(seen, Array.from({ length: 20 }, (_, i) => i));
});
