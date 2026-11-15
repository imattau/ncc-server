import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, KIND_ARTICLE, KIND_IMAGE, KIND_NSITE_NAMED } from '../src/store.js';

function freshStore() {
  const dir = mkdtempSync(join(tmpdir(), 'ncc-search-store-content-test-'));
  const store = openStore(join(dir, 'test.db'));
  return { store, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('upsertContent indexes an article with no reachability claim', () => {
  const { store, cleanup } = freshStore();
  try {
    store.upsertContent({
      pubkey: 'a'.repeat(64),
      itemId: 'my-post',
      kind: KIND_ARTICLE,
      title: 'My Post',
      description: 'A summary',
      body: 'The full article body mentions wallets.',
      mediaUrl: null,
      mediaType: null,
      thumbnailUrl: 'https://example.com/cover.jpg',
      endpoint: null,
    });

    const row = store.getService('a'.repeat(64), 'my-post');
    assert.equal(row.kind, KIND_ARTICLE);
    assert.equal(row.last_status, null, 'articles are never fetched, so there is no status to report');
    assert.equal(row.last_reachable_at, null);
    assert.equal(row.thumbnail_url, 'https://example.com/cover.jpg');

    const results = store.search('wallets');
    assert.equal(results.length, 1);
    assert.equal(results[0].itemId, 'my-post');
  } finally {
    cleanup();
  }
});

test('upsertNsite stores an extracted og:image as the thumbnail, and a later fetch with none keeps it', () => {
  const { store, cleanup } = freshStore();
  try {
    const resolved = {
      pubkey: 'c'.repeat(64),
      kind: 35128,
      siteId: 'blog',
      title: 'My nsite',
      description: null,
    };

    store.upsertNsite(resolved, { status: 200, title: 'My nsite', image: 'https://cdn.example/cover.png' });

    const row = store.getService(resolved.pubkey, 'blog');
    assert.equal(row.kind, KIND_NSITE_NAMED);
    assert.equal(row.thumbnail_url, 'https://cdn.example/cover.png');

    // A re-crawl that found no og:image (e.g. the NIP-05-only enrichment
    // pass, which fetches no content at all) must not blank out a
    // thumbnail a previous fetch already found -- same COALESCE guarantee
    // title/description/body already rely on, see store.js's upsertRow.
    store.upsertNsite(resolved, { status: 200, title: 'My nsite' });
    const after = store.getService(resolved.pubkey, 'blog');
    assert.equal(after.thumbnail_url, 'https://cdn.example/cover.png');
  } finally {
    cleanup();
  }
});

test('attachNip05 updates every row for a pubkey across kinds, and keeps body text intact', () => {
  const { store, cleanup } = freshStore();
  try {
    const pubkey = 'b'.repeat(64);
    store.upsertContent({
      pubkey,
      itemId: 'article-1',
      kind: KIND_ARTICLE,
      title: 'Article',
      description: null,
      body: 'searchable article body',
      mediaUrl: null,
      mediaType: null,
      thumbnailUrl: null,
      endpoint: null,
    });
    store.upsertContent({
      pubkey,
      itemId: 'image-1',
      kind: KIND_IMAGE,
      title: 'A picture',
      description: null,
      body: 'searchable image caption',
      mediaUrl: 'https://cdn.example.com/x.jpg',
      mediaType: 'image/jpeg',
      thumbnailUrl: 'https://cdn.example.com/x.jpg',
      endpoint: null,
    });

    store.attachNip05(pubkey, 'alice@example.com');

    const article = store.getService(pubkey, 'article-1');
    const image = store.getService(pubkey, 'image-1');
    assert.equal(article.nip05, 'alice@example.com');
    assert.equal(image.nip05, 'alice@example.com');
    // The regression this guards: attaching nip05 must not blank out
    // previously-indexed body text (see store.js's syncFts/upsertRow).
    assert.equal(article.body, 'searchable article body');
    assert.equal(image.body, 'searchable image caption');

    const results = store.search('caption');
    assert.equal(results.length, 1);
    assert.equal(results[0].nip05, 'alice@example.com');
  } finally {
    cleanup();
  }
});
