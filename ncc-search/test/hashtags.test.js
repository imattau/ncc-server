import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractHashtags } from '../src/adapters/hashtags.js';

function event(tags) {
  return { pubkey: 'a'.repeat(64), tags, content: '' };
}

test('extractHashtags collects t tags, lowercased', () => {
  assert.deepEqual(extractHashtags(event([['t', 'Bitcoin'], ['t', 'Nostr']])), ['bitcoin', 'nostr']);
});

test('extractHashtags deduplicates case-insensitively', () => {
  assert.deepEqual(extractHashtags(event([['t', 'Bitcoin'], ['t', 'bitcoin'], ['t', 'BITCOIN']])), ['bitcoin']);
});

test('extractHashtags ignores other tag types and malformed t tags', () => {
  assert.deepEqual(extractHashtags(event([['d', 'my-post'], ['t'], ['title', 'x'], ['t', 'nostr']])), ['nostr']);
});

test('extractHashtags returns [] when there are no t tags', () => {
  assert.deepEqual(extractHashtags(event([['d', 'my-post']])), []);
});
