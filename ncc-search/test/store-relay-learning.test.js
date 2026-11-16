import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../src/store.js';

test('relay-learning evidence and promoted relays survive reopening the database', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ncc-search-relays-'));
  const dbPath = join(dir, 'index.db');
  try {
    let store = openStore(dbPath);
    const now = Math.floor(Date.now() / 1000);
    store.upsertContent({ pubkey: 'a'.repeat(64), itemId: 'one', kind: 'article', title: 'one' });
    store.saveNip65RelayList('a'.repeat(64), now, ['wss://relay.example/']);
    store.markNip65AuthorChecked('a'.repeat(64), now);
    store.saveLearnedRelay('wss://relay.example/');
    store.recordLearnedRelayProbe('wss://relay.example/', null);
    store.db.close();

    store = openStore(dbPath);
    assert.deepEqual(store.listNip65AuthorsToCheck(5, 60), []);
    assert.deepEqual(store.listNip65RelayCandidates({ now: now + 1, maxAgeSeconds: 60 }), [
      { url: 'wss://relay.example/', authorCount: 1 },
    ]);
    assert.deepEqual(store.listLearnedRelays().map((relay) => relay.url), ['wss://relay.example/']);
    assert.equal(store.listLearnedRelays()[0].lastError, null);
    store.db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
