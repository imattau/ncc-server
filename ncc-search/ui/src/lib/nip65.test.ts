import { test } from 'vitest';
import assert from 'node:assert/strict';

import type { NostrEvent } from '@nostrify/nostrify';

import { KIND_RELAY_LIST, newestRelayList, readRelaysFromEvent } from './nip65';

function event(overrides: Partial<NostrEvent> = {}): NostrEvent {
  return {
    id: 'e'.repeat(64),
    pubkey: 'a'.repeat(64),
    kind: KIND_RELAY_LIST,
    created_at: 1_700_000_000,
    content: '',
    tags: [],
    sig: 'f'.repeat(128),
    ...overrides,
  } as NostrEvent;
}

test('read relays keep unmarked and "read" tags, drop "write" markers', () => {
  const relays = readRelaysFromEvent(event({
    tags: [
      ['r', 'wss://both.example'],
      ['r', 'wss://read.example', 'read'],
      ['r', 'wss://write.example', 'write'],
    ],
  }));
  assert.deepEqual(relays, ['wss://both.example', 'wss://read.example']);
});

test('read relays are validated, deduplicated and capped', () => {
  const relays = readRelaysFromEvent(event({
    tags: [
      ['r', 'wss://a.example/'],
      ['r', 'wss://a.example'],
      ['r', 'https://not-a-relay.example'],
      ['r', 'not a url'],
      ...Array.from({ length: 10 }, (_, i) => ['r', `wss://r${i}.example`]),
    ],
  }));
  assert.equal(relays.length, 6);
  assert.equal(relays[0], 'wss://a.example');
});

test('a non-10002 event produces no relays', () => {
  assert.deepEqual(readRelaysFromEvent(event({ kind: 3, tags: [['r', 'wss://a.example']] })), []);
  assert.deepEqual(readRelaysFromEvent(null), []);
});

test('newestRelayList picks the latest created_at, ignoring other kinds', () => {
  const older = event({ created_at: 100, tags: [['r', 'wss://old.example']] });
  const newer = event({ created_at: 200, tags: [['r', 'wss://new.example']] });
  const other = event({ created_at: 300, kind: 3 });
  assert.equal(newestRelayList([older, other, newer]), newer);
  assert.equal(newestRelayList([]), null);
});
