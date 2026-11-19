import { test } from 'node:test';
import assert from 'node:assert/strict';

import { KIND_LIVE_STREAM, resolveLiveStream } from '../src/adapters/live.js';

function event(overrides = {}) {
  return {
    id: 'e'.repeat(64),
    pubkey: 'a'.repeat(64),
    kind: KIND_LIVE_STREAM,
    created_at: 1_700_000_000,
    content: '',
    tags: [
      ['d', 'stream-1'],
      ['title', 'Friday stream'],
      ['summary', 'Talking about Nostr'],
      ['image', 'https://example.com/live.jpg'],
      ['streaming', 'https://example.com/live.m3u8'],
      ['recording', 'https://example.com/recording.mp4'],
      ['starts', '1700000000'],
      ['ends', '1700003600'],
      ['status', 'live'],
      ['current_participants', '42'],
      ['t', 'Nostr'],
    ],
    ...overrides,
  };
}

test('a live stream maps its stream URL, status and times', () => {
  const resolved = resolveLiveStream(event());
  assert.ok(resolved);
  assert.equal(resolved.kind, 'live-stream');
  assert.equal(resolved.itemId, 'stream-1');
  assert.equal(resolved.title, 'Friday stream');
  assert.equal(resolved.description, 'Talking about Nostr');
  assert.equal(resolved.endpoint, 'https://example.com/live.m3u8');
  assert.equal(resolved.thumbnailUrl, 'https://example.com/live.jpg');
  assert.equal(resolved.startsAt, 1700000000);
  assert.equal(resolved.endsAt, 1700003600);
  assert.equal(resolved.status, 'live');
  assert.equal(resolved.participantCount, 42);
  assert.equal(resolved.allDay, 0);
  assert.equal(resolved.location, null);
  assert.deepEqual(resolved.hashtags, ['nostr']);
});

test('an ended stream falls back to its recording URL', () => {
  const resolved = resolveLiveStream(event({
    tags: [
      ['d', 'stream-1'],
      ['title', 'Friday stream'],
      ['recording', 'https://example.com/recording.mp4'],
      ['status', 'ended'],
    ],
  }));
  assert.equal(resolved.endpoint, 'https://example.com/recording.mp4');
  assert.equal(resolved.status, 'ended');
});

test('an unknown status is dropped, not passed through', () => {
  const resolved = resolveLiveStream(event({
    tags: [['d', 'x'], ['title', 'Stream'], ['status', 'maybe']],
  }));
  assert.equal(resolved.status, null);
});

test('a stream with no d tag or no title is skipped', () => {
  assert.equal(resolveLiveStream(event({ tags: [['title', 'No identity']] })), null);
  assert.equal(resolveLiveStream(event({ tags: [['d', 'x']] })), null);
});
