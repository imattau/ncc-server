import { test } from 'vitest';
import assert from 'node:assert/strict';

import type { ResultKind } from '@/lib/api';

import { LocalSearchIndex, sortRows } from './search';
import type { LocalRow } from './types';

function row(overrides: Partial<LocalRow> & { itemId: string }): LocalRow {
  const kind: ResultKind = overrides.kind ?? 'article';
  const pubkey = overrides.pubkey ?? 'a'.repeat(64);
  return {
    key: `${kind}\u0000${pubkey}\u0000${overrides.itemId}`,
    pubkey,
    kind,
    eventId: 'e'.repeat(64),
    eventCreatedAt: 1_700_000_000,
    firstSeenAt: 1_800_000_000,
    updatedAt: 1_800_000_000,
    postedAt: null,
    title: null,
    description: null,
    body: null,
    endpoint: null,
    mediaUrl: null,
    mediaType: null,
    thumbnailUrl: null,
    blurhash: null,
    thumbhash: null,
    hashtags: null,
    contentWarning: null,
    ...overrides,
  };
}

test('the index matches title, description, hashtags and body, with title matches scoring higher', () => {
  const index = new LocalSearchIndex();
  const titleMatch = row({ itemId: 'title-match', title: 'Wallet guide' });
  const bodyMatch = row({ itemId: 'body-match', title: 'Something else', body: 'A wallet appears in this text.' });
  const hashtagMatch = row({ itemId: 'tag-match', title: 'Third', hashtags: ['wallet'] });
  index.addAll([titleMatch, bodyMatch, hashtagMatch]);

  const scores = index.match('wallet');
  assert.equal(scores.size, 3);
  assert.ok(
    (scores.get(titleMatch.key) ?? 0) > (scores.get(bodyMatch.key) ?? 0),
    'title is weighted above body',
  );
  assert.ok((scores.get(bodyMatch.key) ?? 0) > 0);
  assert.ok((scores.get(hashtagMatch.key) ?? 0) > 0);

  // The last term is a prefix, matching the server's `"wallet"*` behavior.
  assert.equal(index.match('wall').size, 3);
  assert.equal(index.match('').size, 0);
});

test('replacing a row updates what it matches, and removing it takes it out', () => {
  const index = new LocalSearchIndex();
  const original = row({ itemId: 'post', title: 'Wallet guide' });
  index.addAll([original]);
  assert.equal(index.match('wallet').size, 1);

  index.put({ ...original, title: 'Hardware guide' });
  assert.equal(index.match('wallet').size, 0);
  assert.equal(index.match('hardware').size, 1);
  assert.equal(index.size, 1, 'replace must not add a duplicate document');

  index.remove(original.key);
  assert.equal(index.size, 0);
  assert.equal(index.match('hardware').size, 0);
});

test('newest and oldest put undated rows last in both directions', () => {
  const rows = [
    row({ itemId: 'middle', postedAt: 1_650_000_000 }),
    row({ itemId: 'newest', postedAt: 1_700_000_000 }),
    row({ itemId: 'oldest', postedAt: 1_600_000_000 }),
    row({ itemId: 'undated', postedAt: null }),
  ];

  assert.deepEqual(
    sortRows(rows, 'newest', new Map()).map((entry) => entry.itemId),
    ['newest', 'middle', 'oldest', 'undated'],
  );
  assert.deepEqual(
    sortRows(rows, 'oldest', new Map()).map((entry) => entry.itemId),
    ['oldest', 'middle', 'newest', 'undated'],
  );
});

test('title sorting is case-insensitive and keeps untitled rows last', () => {
  const rows = [
    row({ itemId: 'b', title: 'beta guide' }),
    row({ itemId: 'a', title: 'Alpha guide' }),
    row({ itemId: 'u', title: null }),
    row({ itemId: 'e', title: '' }),
  ];

  assert.deepEqual(
    sortRows(rows, 'title', new Map()).map((entry) => entry.itemId),
    ['a', 'b', 'e', 'u'],
  );
  assert.deepEqual(
    sortRows(rows, 'title-desc', new Map()).map((entry) => entry.itemId),
    ['b', 'a', 'e', 'u'],
  );
});

test('relevance orders by score and breaks ties on item id, like the server', () => {
  const rows = [
    row({ itemId: 'd', pubkey: 'c'.repeat(64) }),
    row({ itemId: 'a', pubkey: 'b'.repeat(64) }),
    row({ itemId: 'b', pubkey: 'a'.repeat(64) }),
  ];
  const scores = new Map([
    [rows[0].key, 5],
    [rows[1].key, 10],
    [rows[2].key, 5],
  ]);
  assert.deepEqual(
    sortRows(rows, 'relevance', scores).map((entry) => entry.itemId),
    ['a', 'b', 'd'],
  );
});
