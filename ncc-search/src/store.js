// SQLite + FTS5 storage. Chosen over Elasticsearch/Postgres (as used by
// searchnos/ndxstr-style Nostr indexers) to match this repo's "no extra
// services" footprint: one file, no separate daemon, same approach the
// sidecar itself takes for its own state (better-sqlite3).
//
// Rows are keyed by (pubkey, item_id) -- a stable identity, never an
// endpoint/blossom URL, since those are expected to change (the whole point
// of NCC-05, and just as true of nsite content moving between Blossom
// servers). `item_id` is adapter-specific: an NCC-02 `d` tag, an nsite's `d`
// tag or the sentinel `_root` for a root site.
//
// One table serves every adapter so search results are unified across
// content types; `kind` discriminates what produced a row.

import Database from 'better-sqlite3';
import { nip19 } from 'nostr-tools';

export const KIND_NCC_SERVICE = 'ncc-service';
export const KIND_NSITE_ROOT = 'nsite-root';
export const KIND_NSITE_NAMED = 'nsite-named';

export function openStore(dbPath) {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS services (
      pubkey TEXT NOT NULL,
      item_id TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT '${KIND_NCC_SERVICE}',
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
      PRIMARY KEY (pubkey, item_id)
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS services_fts USING fts5(
      pubkey UNINDEXED,
      item_id UNINDEXED,
      title,
      description,
      nip05,
      body
    );
  `);

  const upsertServiceStmt = db.prepare(`
    INSERT INTO services (
      pubkey, item_id, kind, npub, nip05, endpoint, fingerprint, family,
      anchored, used_fallback, attestation_count, is_revoked, ttl_seconds,
      last_resolved_at, last_reachable_at, last_status, last_error,
      title, description, body
    ) VALUES (
      @pubkey, @itemId, @kind, @npub, @nip05, @endpoint, @fingerprint, @family,
      @anchored, @usedFallback, @attestationCount, @isRevoked, @ttlSeconds,
      @lastResolvedAt, @lastReachableAt, @lastStatus, @lastError,
      @title, @description, @body
    )
    ON CONFLICT (pubkey, item_id) DO UPDATE SET
      kind = excluded.kind,
      npub = excluded.npub,
      nip05 = COALESCE(excluded.nip05, services.nip05),
      endpoint = excluded.endpoint,
      fingerprint = excluded.fingerprint,
      family = excluded.family,
      anchored = excluded.anchored,
      used_fallback = excluded.used_fallback,
      attestation_count = excluded.attestation_count,
      is_revoked = excluded.is_revoked,
      ttl_seconds = excluded.ttl_seconds,
      last_resolved_at = excluded.last_resolved_at,
      last_reachable_at = COALESCE(excluded.last_reachable_at, services.last_reachable_at),
      last_status = excluded.last_status,
      last_error = excluded.last_error,
      title = COALESCE(excluded.title, services.title),
      description = COALESCE(excluded.description, services.description),
      body = COALESCE(excluded.body, services.body)
  `);

  // Partial updates (e.g. attaching a NIP-05 handle without re-fetching
  // content) must not blank out previously indexed text, so the FTS row is
  // always rebuilt FROM the persisted `services` row after the upsert above
  // has already applied its COALESCEs, never from the raw incoming `row`.
  const selectMergedStmt = db.prepare(
    `SELECT pubkey, item_id AS "itemId", title, description, nip05, body FROM services WHERE pubkey = ? AND item_id = ?`,
  );
  const deleteFtsStmt = db.prepare(`DELETE FROM services_fts WHERE pubkey = ? AND item_id = ?`);
  const insertFtsStmt = db.prepare(`
    INSERT INTO services_fts (pubkey, item_id, title, description, nip05, body)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  const upsertTxn = db.transaction((row) => {
    upsertServiceStmt.run(row);
    const merged = selectMergedStmt.get(row.pubkey, row.itemId);
    deleteFtsStmt.run(row.pubkey, row.itemId);
    if (merged.title || merged.description || merged.body || merged.nip05) {
      insertFtsStmt.run(
        merged.pubkey,
        merged.itemId,
        merged.title,
        merged.description,
        merged.nip05,
        merged.body || '',
      );
    }
  });

  /** Shared by every adapter; adapter-specific wrappers below shape their own result into this row. */
  function upsertRow(row) {
    upsertTxn(row);
  }

  /**
   * @param {import('./resolver.js').ResolvedService} resolved
   * @param {{ status?: number|null, error?: string|null, title?: string|null, description?: string|null, body?: string|null }} fetched
   */
  function upsertService(resolved, fetched = {}) {
    const now = Math.floor(Date.now() / 1000);
    const reachable = fetched.status != null && fetched.status < 400;
    upsertRow({
      pubkey: resolved.pubkey,
      itemId: resolved.serviceId,
      kind: KIND_NCC_SERVICE,
      npub: safeNpub(resolved.pubkey),
      nip05: null,
      endpoint: resolved.endpoint,
      fingerprint: resolved.fingerprint,
      family: resolved.family,
      anchored: resolved.anchored ? 1 : 0,
      usedFallback: resolved.usedFallback ? 1 : 0,
      attestationCount: resolved.attestationCount || 0,
      isRevoked: resolved.isRevoked ? 1 : 0,
      ttlSeconds: resolved.ttlSeconds,
      lastResolvedAt: now,
      lastReachableAt: reachable ? now : null,
      lastStatus: fetched.status ?? null,
      lastError: fetched.error ?? resolved.anchorError ?? resolved.locatorError ?? null,
      title: fetched.title ?? null,
      description: fetched.description ?? null,
      body: fetched.body ?? null,
    });
  }

  /**
   * @param {import('./adapters/nsite.js').ResolvedSite} resolved
   * @param {{ status?: number|null, error?: string|null, title?: string|null, description?: string|null, body?: string|null }} fetched
   * @param {string|null} nip05 - verified `name@domain` (or bare domain for `_`), or null if absent/unverifiable
   */
  function upsertNsite(resolved, fetched = {}, nip05 = null) {
    const now = Math.floor(Date.now() / 1000);
    const reachable = fetched.status != null && fetched.status < 400;
    // Precedence: a freshly fetched page title/description beats anything
    // already stored, which beats the manifest's own `title`/`description`
    // tags. Without the `existing` step, an enrichment-only pass (e.g.
    // attaching NIP-05, which fetches no content) would fall straight to the
    // manifest tags and silently downgrade a better title already indexed
    // from a real content fetch -- reproduced this while adding the NIP-05
    // adapter, see test/nsite-adapter.test.js for the regression case.
    const existing = getService(resolved.pubkey, resolved.siteId);
    upsertRow({
      pubkey: resolved.pubkey,
      itemId: resolved.siteId,
      kind: resolved.kind === 15128 ? KIND_NSITE_ROOT : KIND_NSITE_NAMED,
      npub: safeNpub(resolved.pubkey),
      nip05,
      endpoint: resolved.entryPath,
      fingerprint: null,
      family: null,
      anchored: 0,
      usedFallback: 0,
      attestationCount: 0,
      isRevoked: 0,
      ttlSeconds: null,
      lastResolvedAt: now,
      lastReachableAt: reachable ? now : null,
      lastStatus: fetched.status ?? null,
      lastError: fetched.error ?? null,
      title: fetched.title ?? existing?.title ?? resolved.title ?? null,
      description: fetched.description ?? existing?.description ?? resolved.description ?? null,
      body: fetched.body ?? null,
    });
  }

  function search(query, limit = 20) {
    return db
      .prepare(
        `SELECT s.pubkey, s.npub, s.nip05, s.item_id AS "itemId", s.kind, s.endpoint,
                s.anchored, s.attestation_count AS "attestationCount",
                s.last_reachable_at AS "lastReachableAt", s.last_status AS "lastStatus",
                s.title, s.description,
                snippet(services_fts, 5, '[', ']', '…', 12) AS snippet
         FROM services_fts f
         JOIN services s ON s.pubkey = f.pubkey AND s.item_id = f.item_id
         WHERE services_fts MATCH ?
         ORDER BY rank
         LIMIT ?`,
      )
      .all(query, limit);
  }

  function getService(pubkey, itemId) {
    return db.prepare(`SELECT * FROM services WHERE pubkey = ? AND item_id = ?`).get(pubkey, itemId);
  }

  function listStale(olderThanSeconds) {
    const cutoff = Math.floor(Date.now() / 1000) - olderThanSeconds;
    return db
      .prepare(`SELECT pubkey, item_id AS "itemId", kind FROM services WHERE last_resolved_at < ?`)
      .all(cutoff);
  }

  return { db, upsertService, upsertNsite, search, getService, listStale };
}

function safeNpub(hexPubkey) {
  try {
    return nip19.npubEncode(hexPubkey);
  } catch {
    return null;
  }
}
