import { test } from 'node:test';
import assert from 'node:assert/strict';
import { statSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, KIND_ARTICLE } from '../src/store.js';

function freshStore(opts) {
  const dir = mkdtempSync(join(tmpdir(), 'ncc-search-store-prune-test-'));
  const dbPath = join(dir, 'test.db');
  const store = openStore(dbPath, opts);
  return { store, dbPath, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function seedRows(store, count, bodyBytes = 20_000) {
  // A large `body` so a handful of rows actually move the file size enough
  // to make a byte-based limit meaningful in a fast test, rather than
  // needing thousands of tiny rows.
  const body = 'x'.repeat(bodyBytes);
  for (let i = 0; i < count; i++) {
    store.upsertContent({
      pubkey: i.toString(16).padStart(64, '0'),
      itemId: `item-${i}`,
      kind: KIND_ARTICLE,
      title: `Item ${i}`,
      description: null,
      body,
      mediaUrl: null,
      mediaType: null,
      thumbnailUrl: null,
      endpoint: null,
    });
  }
}

test('pruneToFit is a no-op when maxBytes is 0/unset -- unbounded growth is the default', () => {
  const { store, cleanup } = freshStore();
  try {
    seedRows(store, 5);
    const result = store.pruneToFit(0);
    assert.equal(result.prunedRows, 0);
    assert.equal(store.search('Item').length, 5, 'nothing should have been evicted');
  } finally {
    cleanup();
  }
});

test('pruneToFit evicts least-recently-resolved rows first (LRU) until under the byte limit', () => {
  const { store, dbPath, cleanup } = freshStore({ maxBytes: 1 });
  try {
    seedRows(store, 10);

    const before = store.search('Item');
    assert.equal(before.length, 10);

    // maxBytes=1 forces pruning down to whatever a single surviving row's
    // page footprint is -- the point is to prove eviction order and that
    // the file actually shrinks, not to land on an exact row count.
    const { prunedRows } = store.pruneToFit(1);
    assert.ok(prunedRows > 0, 'should have pruned at least one row');

    const after = store.search('Item');
    assert.ok(after.length < before.length, 'row count should have dropped');

    // Oldest-inserted rows (lowest last_resolved_at) go first: item-0
    // should be gone well before item-9 if anything survived at all.
    const survivingIds = after.map((r) => r.itemId);
    if (survivingIds.length > 0) {
      assert.ok(
        !survivingIds.includes('item-0'),
        'item-0 (oldest) should be pruned before later items survive',
      );
    }

    // The whole point of auto_vacuum + incremental_vacuum: the file on
    // disk must actually have shrunk, not just internally freed pages.
    const finalSize = statSync(dbPath).size;
    assert.ok(finalSize < 200_000, `expected file to shrink well below its seeded size, got ${finalSize} bytes`);
  } finally {
    cleanup();
  }
});

test('pruneToFit stops once nothing is left to prune, rather than looping forever', () => {
  const { store, cleanup } = freshStore({ maxBytes: 1 });
  try {
    seedRows(store, 3);
    const first = store.pruneToFit(1);
    assert.ok(first.prunedRows > 0);
    // A second call with nothing left under the (unreachable) limit must
    // return promptly instead of spinning -- the empty-batch break is what
    // guarantees that.
    const second = store.pruneToFit(1);
    assert.equal(store.search('Item').length, 0);
    assert.equal(second.prunedRows, 0);
  } finally {
    cleanup();
  }
});
