import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { openStore } from '../src/store.js';

// `CREATE TABLE IF NOT EXISTS` in openStore() only builds the table on a
// brand new database file -- it does nothing for a column added after a
// database already exists, which is exactly the situation a long-running
// deployment's database is in once a schema change like seen_relays ships.
// This simulates that: a `services` table built from an *old* schema,
// missing the column, opened by the *current* openStore().
test('openStore adds seen_relays via ALTER TABLE to a database from before that column existed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ncc-search-store-migration-test-'));
  const dbPath = join(dir, 'test.db');
  try {
    // The real schema minus `seen_relays` -- a stripped-down fake table
    // would make every other prepared statement in openStore() fail at
    // prepare() time (better-sqlite3 validates column references against
    // the schema immediately, not lazily), which would test the wrong
    // thing: this is specifically about the one column that's new.
    const raw = new Database(dbPath);
    raw.exec(`
      CREATE TABLE services (
        pubkey TEXT NOT NULL,
        item_id TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'ncc-service',
        npub TEXT,
        nip05 TEXT,
        endpoint TEXT,
        fingerprint TEXT,
        family TEXT,
        anchored INTEGER NOT NULL DEFAULT 0,
        used_fallback INTEGER NOT NULL DEFAULT 0,
        attestation_count INTEGER NOT NULL DEFAULT 0,
        is_revoked INTEGER NOT NULL DEFAULT 0,
        ttl_seconds INTEGER,
        last_resolved_at INTEGER,
        last_reachable_at INTEGER,
        last_status INTEGER,
        last_error TEXT,
        title TEXT,
        description TEXT,
        body TEXT,
        media_url TEXT,
        media_type TEXT,
        thumbnail_url TEXT,
        blurhash TEXT,
        thumbhash TEXT,
        hashtags TEXT,
        content_warning TEXT,
        PRIMARY KEY (pubkey, item_id)
      );
    `);
    raw.close();

    assert.doesNotThrow(() => openStore(dbPath));

    const check = new Database(dbPath);
    const columns = check.prepare(`PRAGMA table_info(services)`).all().map((c) => c.name);
    check.close();
    assert.ok(columns.includes('seen_relays'), 'seen_relays must exist after opening an old database');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('openStore is idempotent -- reopening an already-migrated database does not error', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ncc-search-store-migration-test-'));
  const dbPath = join(dir, 'test.db');
  try {
    openStore(dbPath).db.close();
    assert.doesNotThrow(() => openStore(dbPath));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
