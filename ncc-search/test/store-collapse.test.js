import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, KIND_NSITE_NAMED, KIND_ARTICLE } from '../src/store.js';

function nsite(store, pubkey, itemId, title, description) {
  store.upsertNsite(
    { pubkey, kind: 35128, siteId: itemId, title, description, entryPath: '/index.html' },
    {},
  );
}

test('search collapses same publisher+title+description and lists alternates', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ncc-search-collapse-'));
  const store = openStore(join(dir, 't.db'));
  try {
    const a = 'a'.repeat(64);
    const b = 'b'.repeat(64);
    nsite(store, a, '1for3podcast', 'PODSTR - Nostr Podcast Platform', 'A nostr podcast app');
    nsite(store, a, '1for3', 'PODSTR - Nostr Podcast Platform', 'A nostr podcast app');
    nsite(store, a, 'other', 'Another nostr thing', 'Different');
    nsite(store, b, '1for3', 'PODSTR - Nostr Podcast Platform', 'A nostr podcast app'); // other publisher
    store.upsertContent({ pubkey: a, itemId: 'post', kind: KIND_ARTICLE, title: 'PODSTR - Nostr Podcast Platform', description: 'A nostr podcast app', body: 'x', endpoint: null });

    const results = store.search('nostr');
    assert.equal(results.length, 4, 'a:podstr-nsite, a:other, b:podstr, a:article');
    const merged = results.find((r) => r.pubkey === a && r.kind === KIND_NSITE_NAMED && r.title.startsWith('PODSTR'));
    assert.deepEqual(merged.alternates.map((x) => x.itemId).length, 1);
    assert.ok(['1for3', '1for3podcast'].includes(merged.itemId));
    assert.notEqual(merged.alternates[0].itemId, merged.itemId);
    assert.deepEqual(results.find((r) => r.itemId === 'other').alternates, []);
    assert.deepEqual(results.find((r) => r.pubkey === b).alternates, []);
  } finally {
    store.close?.();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('records with no title and description are never merged; paging still works', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ncc-search-collapse-'));
  const store = openStore(join(dir, 't.db'));
  try {
    const a = 'a'.repeat(64);
    store.upsertContent({ pubkey: a, itemId: 'p1', kind: KIND_ARTICLE, title: null, description: null, body: 'wallet notes', endpoint: null });
    store.upsertContent({ pubkey: a, itemId: 'p2', kind: KIND_ARTICLE, title: null, description: null, body: 'wallet notes', endpoint: null });
    assert.equal(store.search('wallet').length, 2);
    assert.equal(store.search('wallet', 1, 1).length, 1);
  } finally {
    store.close?.();
    rmSync(dir, { recursive: true, force: true });
  }
});
