import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, KIND_ARTICLE } from '../src/store.js';

function freshStore() {
  const dir = mkdtempSync(join(tmpdir(), 'ncc-search-store-remove-test-'));
  const store = openStore(join(dir, 'test.db'));
  return { store, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('removeService deletes the ordinary row and its full-text entry', () => {
  const { store, cleanup } = freshStore();
  try {
    store.upsertContent({
      pubkey: 'a'.repeat(64),
      itemId: 'private-service',
      kind: KIND_ARTICLE,
      title: 'Private service',
      description: 'Was public before a visibility change',
      body: 'needle-in-the-index',
      mediaUrl: null,
      mediaType: null,
      thumbnailUrl: null,
      endpoint: null,
    });
    assert.equal(store.search('needle-in-the-index').length, 1);

    assert.equal(store.removeService('a'.repeat(64), 'private-service'), 1);
    assert.equal(store.getService('a'.repeat(64), 'private-service'), undefined);
    assert.equal(store.search('needle-in-the-index').length, 0);
  } finally {
    cleanup();
  }
});

test('removeService is a cheap no-op for a service that was never indexed', () => {
  const { store, cleanup } = freshStore();
  try {
    assert.equal(store.removeService('b'.repeat(64), 'never-indexed'), 0);
  } finally {
    cleanup();
  }
});
