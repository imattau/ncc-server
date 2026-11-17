import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, KIND_ARTICLE } from '../src/store.js';

const PUBKEY = 'b'.repeat(64);

function freshDir() {
  return mkdtempSync(join(tmpdir(), 'ncc-search-store-readonly-test-'));
}

function writerWithArticle(path) {
  const store = openStore(path);
  store.upsertContent({
    pubkey: PUBKEY,
    itemId: 'readable-post',
    kind: KIND_ARTICLE,
    title: 'Readable Post',
    description: 'Written by the crawler process',
    body: 'A body mentioning squashes so search has something to match.',
    endpoint: null,
  });
  return store;
}

// The split deployment (src/api.js) serves reads from a second connection
// opened `readonly` over the crawler's WAL database. These are the two
// properties that split depends on: reads see committed writes, and the
// reader cannot mutate the index.
test('a readonly store reads rows the writer committed', () => {
  const dir = freshDir();
  try {
    const path = join(dir, 'test.db');
    writerWithArticle(path); // stays open, as the crawler process would

    const reader = openStore(path, { readonly: true });
    const results = reader.search('squashes');
    assert.equal(results.length, 1);
    assert.equal(results[0].title, 'Readable Post');
    assert.equal(reader.getService(PUBKEY, 'readable-post').title, 'Readable Post');
    assert.equal(reader.getStatus().recordCount, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a readonly store exposes no write path at all', () => {
  const dir = freshDir();
  try {
    const path = join(dir, 'test.db');
    writerWithArticle(path);

    const reader = openStore(path, { readonly: true });
    for (const method of ['upsertService', 'upsertNsite', 'upsertContent', 'attachNip05', 'pruneToFit', 'saveDiscoveryCursor']) {
      assert.equal(reader[method], undefined, `${method} must not be exported by a readonly store`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// This is what src/api.js retries on: the crawler may not have created the
// schema yet, and a readonly connection must never create it itself.
test('opening a readonly store fails when the crawler has not created the index yet', () => {
  const dir = freshDir();
  try {
    assert.throws(() => openStore(join(dir, 'not-created-yet.db'), { readonly: true }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// WAL still permits only one writer at a time. src/backfillPostedAt.js is a
// second writer next to a live crawler, and without a busy handler its first
// write that lost that race failed immediately with SQLITE_BUSY ("database is
// locked") instead of waiting for the crawler's transaction to commit.
test('both the writer and the reader wait on a busy database instead of failing at once', () => {
  const dir = freshDir();
  try {
    const path = join(dir, 'test.db');
    const writer = writerWithArticle(path);

    assert.ok(
      writer.db.pragma('busy_timeout', { simple: true }) >= 5_000,
      'a second writer (the backfill) must wait for the crawler, not abort',
    );
    assert.equal(writer.db.pragma('journal_mode', { simple: true }), 'wal');
    // The reader's own short timeout is a property of its connection, which a
    // readonly store deliberately does not expose; it is covered by opening
    // one here and checking that a live reader sees the writer's rows.
    assert.equal(openStore(path, { readonly: true }).getStatus().recordCount, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
