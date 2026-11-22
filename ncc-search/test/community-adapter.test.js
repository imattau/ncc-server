import { test } from 'node:test';
import assert from 'node:assert/strict';

import { KIND_COMMUNITY, resolveCommunity } from '../src/adapters/community.js';

function communityEvent(overrides = {}) {
  return {
    id: 'c'.repeat(64),
    pubkey: 'a'.repeat(64),
    kind: KIND_COMMUNITY,
    created_at: 1_700_000_000,
    content: 'A place for **writers**.',
    tags: [
      ['d', 'writers'],
      ['name', 'Nostr Writers'],
      ['description', 'Fiction and non-fiction on Nostr'],
      ['image', 'https://cdn.example.com/community.png'],
      ['p', 'b'.repeat(64), 'wss://relay.example.com', 'moderator'],
      ['relay', 'wss://relay.example.com', 'requests'],
      ['t', 'Writing'],
    ],
    ...overrides,
  };
}

test('a community maps its name, description, image and hashtags', () => {
  const resolved = resolveCommunity(communityEvent());
  assert.ok(resolved);
  assert.equal(resolved.kind, 'community');
  assert.equal(resolved.itemId, 'writers');
  assert.equal(resolved.title, 'Nostr Writers');
  assert.equal(resolved.description, 'Fiction and non-fiction on Nostr');
  assert.match(resolved.body, /A place for writers\./);
  assert.equal(resolved.thumbnailUrl, 'https://cdn.example.com/community.png');
  assert.equal(resolved.endpoint, null, 'a community has a relay coordinate, not a web page');
  assert.deepEqual(resolved.hashtags, ['writing']);
  assert.equal(resolved.postedAt, 1_700_000_000);
});

test('the d tag is the title when no name tag is set', () => {
  const resolved = resolveCommunity(communityEvent({ tags: [['d', 'writers']] }));
  assert.equal(resolved.title, 'writers');
  assert.equal(resolved.description, null);
});

test('a community with no d tag is skipped', () => {
  assert.equal(resolveCommunity(communityEvent({ tags: [['name', 'No identity']] })), null);
});
