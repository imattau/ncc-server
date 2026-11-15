import { test } from 'node:test';
import assert from 'node:assert/strict';
import { takeSeenRelays } from '../src/relayTracking.js';

function fakePool(seenOn) {
  return { seenOn };
}

test('takeSeenRelays returns sorted, deduplicated relay URLs and clears the entry', () => {
  const pool = fakePool(
    new Map([
      [
        'abc',
        new Set([{ url: 'wss://relay.b.example' }, { url: 'wss://relay.a.example' }, { url: 'wss://relay.a.example' }]),
      ],
    ]),
  );

  assert.deepEqual(takeSeenRelays(pool, 'abc'), ['wss://relay.a.example', 'wss://relay.b.example']);
  // The whole point of taking it: nothing left behind to leak memory on a
  // long-running process.
  assert.equal(pool.seenOn.has('abc'), false);
});

test('takeSeenRelays returns an empty list for an unknown event id', () => {
  const pool = fakePool(new Map());
  assert.deepEqual(takeSeenRelays(pool, 'never-seen'), []);
});

test('takeSeenRelays is safe against a pool with no seenOn at all (trackRelays off, or a bare test pool)', () => {
  assert.deepEqual(takeSeenRelays({}, 'abc'), []);
});
