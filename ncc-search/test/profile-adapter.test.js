import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveProfile } from '../src/adapters/profile.js';

function profileEvent(metadata, overrides = {}) {
  return {
    pubkey: 'a'.repeat(64),
    content: JSON.stringify(metadata),
    tags: [],
    ...overrides,
  };
}

test('resolveProfile extracts display_name/about/picture/website', () => {
  const resolved = resolveProfile(
    profileEvent({
      name: 'alice',
      display_name: 'Alice',
      about: 'Just here for the nostr.',
      picture: 'https://example.com/alice.jpg',
      website: 'https://alice.example.com',
      nip05: 'alice@example.com',
    }),
  );
  assert.equal(resolved.itemId, '_profile');
  assert.equal(resolved.kind, 'profile');
  assert.equal(resolved.title, 'Alice');
  assert.equal(resolved.description, 'Just here for the nostr.');
  assert.equal(resolved.thumbnailUrl, 'https://example.com/alice.jpg');
  assert.equal(resolved.endpoint, 'https://alice.example.com');
});

test('resolveProfile falls back from display_name to name', () => {
  const resolved = resolveProfile(profileEvent({ name: 'bob' }));
  assert.equal(resolved.title, 'bob');
});

test('resolveProfile returns null for unparseable content', () => {
  assert.equal(resolveProfile(profileEvent({}, { content: 'not json' })), null);
});

test('resolveProfile ignores non-string fields rather than indexing junk', () => {
  const resolved = resolveProfile(profileEvent({ name: 42, about: { not: 'a string' } }));
  assert.equal(resolved.title, null);
  assert.equal(resolved.description, null);
});
