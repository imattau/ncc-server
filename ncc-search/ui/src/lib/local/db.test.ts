import { test } from 'vitest';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';

import { openDb } from './db';
import type { LocalRow } from './types';

function row(key: string): LocalRow {
  return {
    key,
    pubkey: 'a'.repeat(64),
    itemId: key,
    kind: 'article',
    eventId: 'e'.repeat(64),
    eventCreatedAt: 1_700_000_000,
    firstSeenAt: 1_800_000_000,
    updatedAt: 1_800_000_000,
    postedAt: 1_700_000_000,
    title: key,
    description: null,
    body: 'text',
    endpoint: null,
    mediaUrl: null,
    mediaType: null,
    thumbnailUrl: null,
    blurhash: null,
    thumbhash: null,
    hashtags: null,
    contentWarning: null,
  };
}

test('rows and cursors survive a close and reopen of the same database', async () => {
  const factory = new IDBFactory();
  const first = await openDb(factory);
  await first.putRows([row('a'), row('b')]);
  await first.putCursors([
    { key: 'wss://relay|kind:30023', relay: 'wss://relay', filterKey: 'kind:30023', until: 1_600_000_000, updatedAt: 1, events: 500, exhausted: false },
  ]);
  await first.setMeta('schema', 1);

  const second = await openDb(factory);
  assert.deepEqual((await second.loadRows()).map((entry) => entry.key).sort(), ['a', 'b']);
  assert.equal((await second.loadCursors())[0].until, 1_600_000_000);
  assert.equal(await second.getMeta('schema'), 1);
});

test('put overwrites by key, delete removes, and clearAll empties every store', async () => {
  const factory = new IDBFactory();
  const db = await openDb(factory);
  await db.putRows([row('a')]);
  await db.putRows([{ ...row('a'), title: 'updated' }]);
  const rows = await db.loadRows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, 'updated');

  await db.putRows([row('b')]);
  await db.deleteRows(['a']);
  assert.deepEqual((await db.loadRows()).map((entry) => entry.key), ['b']);

  await db.putCursors([
    { key: 'r|k', relay: 'r', filterKey: 'k', until: 1, updatedAt: 1, events: 1, exhausted: true },
  ]);
  await db.clearAll();
  assert.equal((await db.loadRows()).length, 0);
  assert.equal((await db.loadCursors()).length, 0);
  assert.equal(await db.getMeta('schema'), undefined);
});

test('a missing cursor or meta value reads as undefined rather than throwing', async () => {
  const db = await openDb(new IDBFactory());
  assert.equal(await db.getMeta('nope'), undefined);
  assert.equal((await db.loadCursors()).length, 0);
});
