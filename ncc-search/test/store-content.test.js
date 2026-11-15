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

test('FTS ranks title matches above a repeated match in the body and exposes index time', () => {
  const { store, cleanup } = freshStore();
  try {
    store.upsertContent({
      pubkey: '1'.repeat(64), itemId: 'title-match', kind: KIND_ARTICLE,
      title: 'Solar guide', description: null, body: 'A short guide.',
    });
    store.upsertContent({
      pubkey: '2'.repeat(64), itemId: 'body-match', kind: KIND_ARTICLE,
      title: 'General notes', description: null, body: 'solar '.repeat(80),
    });

    const results = store.search('solar');
    assert.equal(results[0].itemId, 'title-match');
    assert.ok(results[0].indexedAt > 1_000_000_000_000, 'indexedAt is Unix milliseconds');
  } finally {
    cleanup();
  }
});

test('curated relevance cases return the expected title match first', () => {
  const { store, cleanup } = freshStore();
  try {
    const cases = [
      { query: 'wallet security', expected: 'wallet-security', title: 'Wallet security basics', body: 'Key management guide.' },
      { query: 'solar mapping', expected: 'solar-mapping', title: 'Solar mapping project', body: 'Satellite imagery notes.' },
      { query: 'leather bags', expected: 'leather-bags', title: 'Leather bags and care', body: 'Materials and maintenance.' },
    ];
    for (const [index, item] of cases.entries()) {
      store.upsertContent({
        pubkey: String(index + 3).repeat(64), itemId: item.expected, kind: KIND_ARTICLE,
        title: item.title, description: null, body: item.body,
      });
    }

    for (const item of cases) {
      assert.equal(store.search(item.query)[0]?.itemId, item.expected, `top result for ${item.query}`);
    }
  } finally {
    cleanup();
  }
});

test('discovery cursors persist independently for each source and relay', () => {
  const { store, cleanup } = freshStore();
  try {
    store.saveDiscoveryCursor('articles', 'wss://relay.example', 1234);
    store.saveDiscoveryCursor('media', 'wss://relay.example', 5678);
    store.saveDiscoveryCursor('articles', 'wss://relay.example', 1000);

    assert.equal(store.getDiscoveryCursor('articles', 'wss://relay.example'), 1234);
    assert.equal(store.getDiscoveryCursor('media', 'wss://relay.example'), 5678);
  } finally {
    cleanup();
  }
});

test('upsertNsite indexes the fetched page body, not just title/description', () => {
  const { store, cleanup } = freshStore();
  try {
    const resolved = {
      pubkey: 'f'.repeat(64),
      kind: 35128,
      siteId: 'blog',
      title: 'My nsite',
      description: null,
    };

    // NsiteAdapter.fetchAndExtract() returns extractDocument()'s own field
    // name, `text` -- see test/nsite-adapter.test.js -- not `body`. The
    // regression this guards: that page content must still end up
    // searchable, not just the title/description.
    store.upsertNsite(resolved, {
      status: 200,
      title: 'My nsite',
      text: 'This page is about leather wallets and bags.',
    });

    const row = store.getService(resolved.pubkey, 'blog');
    assert.equal(row.body, 'This page is about leather wallets and bags.');

    const results = store.search('wallets');
    assert.equal(results.length, 1);
    assert.equal(results[0].itemId, 'blog');
  } finally {
    cleanup();
  }
});

test('upsertNsite records which relays delivered the event, and a later pass with none keeps it', () => {
  const { store, cleanup } = freshStore();
  try {
    const resolved = {
      pubkey: 'd'.repeat(64),
      kind: 35128,
      siteId: 'blog',
      title: 'My nsite',
      description: null,
    };

    store.upsertNsite(
      resolved,
      { status: 200, title: 'My nsite' },
      null,
      ['wss://relay.b.example', 'wss://relay.a.example'],
    );

    const row = store.getService(resolved.pubkey, 'blog');
    assert.deepEqual(JSON.parse(row.seen_relays), ['wss://relay.b.example', 'wss://relay.a.example']);

    // A later pass that didn't record any relays (e.g. the NIP-05-only
    // enrichment path) must not blank this out -- same COALESCE guarantee
    // title/description/thumbnail already rely on.
    store.upsertNsite(resolved, { status: 200, title: 'My nsite' }, null, []);
    const after = store.getService(resolved.pubkey, 'blog');
    assert.deepEqual(JSON.parse(after.seen_relays), ['wss://relay.b.example', 'wss://relay.a.example']);
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
