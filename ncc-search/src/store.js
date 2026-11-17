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

import { statSync, statfsSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { nip19 } from 'nostr-tools';

export const KIND_NCC_SERVICE = 'ncc-service';
export const KIND_NSITE_ROOT = 'nsite-root';
export const KIND_NSITE_NAMED = 'nsite-named';
export const KIND_ARTICLE = 'article';
export const KIND_IMAGE = 'image';
export const KIND_VIDEO = 'video';
export const KIND_PROFILE = 'profile';
export const KIND_NPACK = 'npack';

/**
 * How long a writer waits for another connection's transaction to commit
 * before SQLITE_BUSY. Ten seconds is far longer than any single write the
 * crawler does; if it is ever hit, something is genuinely stuck and failing
 * is better than blocking the caller forever.
 */
const WRITER_BUSY_TIMEOUT_MS = 10_000;

/**
 * @param {string} dbPath
 * @param {{ maxBytes?: number, readonly?: boolean }} [opts] - `maxBytes`: a
 *   disk-space ceiling enforced by {@link pruneToFit}; 0/omitted means
 *   unbounded (unchanged default behaviour). `readonly`: open the index for
 *   reading only, as the API process does (see src/api.js) -- the crawler
 *   process is the single writer, so a reader must not create the schema,
 *   migrate it, or VACUUM it out from under the writer. A readonly store
 *   exposes only `search`, `getService` and `getStatus`.
 */
export function openStore(dbPath, opts = {}) {
  const maxBytes = opts.maxBytes || 0;
  const readonly = opts.readonly === true;
  const db = new Database(dbPath, readonly ? { readonly: true, fileMustExist: true } : {});
  if (readonly) {
    // WAL readers never block the writer, but a read that loses a race with
    // the crawler's checkpoint can still return SQLITE_BUSY: fail the request
    // after a short wait instead of queueing HTTP behind it indefinitely.
    db.pragma('busy_timeout = 2000');
  } else {
    db.pragma('journal_mode = WAL');
    // WAL allows many readers but still only one writer at a time. The
    // crawler is normally the only writer, so this only matters when a
    // maintenance script (src/backfillPostedAt.js) opens its own connection
    // against a live index: without a busy handler the loser of that race
    // fails immediately with SQLITE_BUSY instead of waiting for the other
    // transaction to commit.
    db.pragma(`busy_timeout = ${WRITER_BUSY_TIMEOUT_MS}`);
  }

  // `auto_vacuum` only takes effect after a VACUUM rewrites the file, so
  // this one-time cost is paid only when a size limit is actually
  // configured -- not on every startup for everyone else. Without it,
  // pruneToFit()'s deletes would free internal SQLite pages without ever
  // shrinking the file on disk, making a "disk space limit" a lie.
  if (!readonly && maxBytes > 0 && db.pragma('auto_vacuum', { simple: true }) !== 2) {
    db.pragma('auto_vacuum = INCREMENTAL');
    db.exec('VACUUM');
  }

  // Schema creation and the ad hoc migration below are writer-only (see
  // this function's `readonly` note above); on a reader they would either
  // fail outright or race the crawler's own writes.
  if (!readonly) {
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
      -- image/video only: the actual media URL, never fetched by this
      -- backend -- the browser loads it directly (see src/adapters/media.js
      -- and ui/src/components/ResultRow.tsx). endpoint keeps meaning "the
      -- page to visit" for ncc-service/nsite rows; media rows use these
      -- instead so the UI can tell the two apart by kind.
      media_url TEXT,
      media_type TEXT,
      thumbnail_url TEXT,
      -- image/video only: an instant, tiny placeholder (NIP-68/71 imeta
      -- fields). blurhash is actually decoded by the UI today
      -- (ui/src/hooks/useBlurhashPlaceholder.ts); thumbhash is stored for
      -- forward compatibility but has no decoder implemented yet -- it uses
      -- a different binary encoding than blurhash's string format.
      blurhash TEXT,
      thumbhash TEXT,
      -- article/image/video only: t tags (NIP-23/68/71), stored as a JSON
      -- array string. Not a ranking signal this backend computes anything
      -- from -- it's exposed so the UI can match them against a logged-in
      -- NIP-07 user's own interests to prioritize results client-side (see
      -- ui/src/lib/ranking.ts). NCC-02/nsite have no hashtag concept, so
      -- this stays null for those kinds.
      hashtags TEXT,
      -- image/video only: the NIP-68/71 content-warning tag's value (or a
      -- generic label if the tag has no reason text), null if absent. The
      -- backend makes no safety decision itself -- it just exposes this for
      -- ui/'s safe-search toggle (see ui/src/hooks/useSafeSearch.ts) to
      -- filter or label on.
      content_warning TEXT,
      -- Article/image/video/nsite/npack only: when the event that built this
      -- row was posted, unix seconds. NIP-23's published_at tag when the
      -- author set it, the event's created_at otherwise (see
      -- src/postedAt.js). This is what the UI shows and sorts by, as opposed
      -- to last_resolved_at, which only says when the crawler last looked.
      -- Null for profiles and NCC-02/05 service rows: a kind:0 is a profile
      -- update, and an anchored service record has no single source event, so
      -- neither has a posting date to report. Also null on rows indexed
      -- before this column existed until re-crawled or backfilled.
      posted_at INTEGER,
      -- nsite/article/image/video only (see relayTracking.js): which
      -- relay(s), by URL, actually delivered the event this row was built
      -- from -- a JSON array string, same encoding as hashtags. A
      -- redundancy signal, not a ranking input this backend computes
      -- anything from today: a record seen on only one relay is one relay
      -- outage away from becoming undiscoverable again, one seen on
      -- several is not. Null for ncc-service rows -- those are built from
      -- a *resolved* anchor+locator (ncc-02-js/ncc-05-js's own relay
      -- traversal via resolver.js), not a single raw event this process
      -- holds onto, so there's no one event id to look up a relay set for.
      seen_relays TEXT,
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

    CREATE TABLE IF NOT EXISTS discovery_cursors (
      source TEXT NOT NULL,
      relay TEXT NOT NULL,
      cursor INTEGER NOT NULL,
      PRIMARY KEY (source, relay)
    );

    CREATE TABLE IF NOT EXISTS nip65_author_checks (
      pubkey TEXT PRIMARY KEY,
      checked_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS nip65_relay_lists (
      pubkey TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      relays TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS learned_relays (
      url TEXT PRIMARY KEY,
      promoted_at INTEGER NOT NULL,
      last_probe_at INTEGER,
      last_error TEXT
    );
    CREATE TABLE IF NOT EXISTS relay_candidate_probes (
      url TEXT PRIMARY KEY,
      last_probe_at INTEGER NOT NULL,
      last_error TEXT
    );
  `);

  // `CREATE TABLE IF NOT EXISTS` above only creates the table on a brand
  // new database -- it does nothing for columns added after a database
  // already exists, which is the situation every long-running deployment is
  // in when a schema change ships. There is still no migration runner; this
  // guard is deliberately small rather than standing one up for a handful of
  // nullable columns, but it lists them explicitly so each addition is one
  // entry rather than another copy of the same ceremony.
    const columns = new Set(
      db.prepare(`PRAGMA table_info(services)`).all().map((column) => column.name),
    );
    for (const [name, type] of [
      ['seen_relays', 'TEXT'],
      ['posted_at', 'INTEGER'],
    ]) {
      if (!columns.has(name)) db.exec(`ALTER TABLE services ADD COLUMN ${name} ${type}`);
    }
  } else {
    // A reader must not migrate the schema, so if the crawler has not added a
    // column this build's queries reference, fail here instead of preparing a
    // statement that throws on every request: src/api.js's open retry loop
    // then waits for the crawler (they ship in the same image, so this is
    // only ever the rollout window).
    const columns = new Set(
      db.prepare(`PRAGMA table_info(services)`).all().map((column) => column.name),
    );
    if (!columns.has('posted_at')) {
      db.close();
      throw new Error(
        'index schema is older than this build (services.posted_at is missing); waiting for the crawler to migrate it',
      );
    }
  }

  const upsertServiceStmt = db.prepare(`
    INSERT INTO services (
      pubkey, item_id, kind, npub, nip05, endpoint, fingerprint, family,
      anchored, used_fallback, attestation_count, is_revoked, ttl_seconds,
      last_resolved_at, last_reachable_at, last_status, last_error,
      title, description, body, media_url, media_type, thumbnail_url,
      blurhash, thumbhash, hashtags, content_warning, posted_at, seen_relays
    ) VALUES (
      @pubkey, @itemId, @kind, @npub, @nip05, @endpoint, @fingerprint, @family,
      @anchored, @usedFallback, @attestationCount, @isRevoked, @ttlSeconds,
      @lastResolvedAt, @lastReachableAt, @lastStatus, @lastError,
      @title, @description, @body, @mediaUrl, @mediaType, @thumbnailUrl,
      @blurhash, @thumbhash, @hashtags, @contentWarning, @postedAt, @seenRelays
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
      body = COALESCE(excluded.body, services.body),
      media_url = COALESCE(excluded.media_url, services.media_url),
      media_type = COALESCE(excluded.media_type, services.media_type),
      thumbnail_url = COALESCE(excluded.thumbnail_url, services.thumbnail_url),
      blurhash = COALESCE(excluded.blurhash, services.blurhash),
      thumbhash = COALESCE(excluded.thumbhash, services.thumbhash),
      hashtags = COALESCE(excluded.hashtags, services.hashtags),
      content_warning = COALESCE(excluded.content_warning, services.content_warning),
      -- A partial update (a NIP-05 recheck, an artifact arriving later) has
      -- no event to read a date from; it must not erase one already stored.
      posted_at = COALESCE(excluded.posted_at, services.posted_at),
      seen_relays = COALESCE(excluded.seen_relays, services.seen_relays)
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

  function syncFts(pubkey, itemId) {
    const merged = selectMergedStmt.get(pubkey, itemId);
    deleteFtsStmt.run(pubkey, itemId);
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
  }

  const upsertTxn = db.transaction((row) => {
    upsertServiceStmt.run(row);
    syncFts(row.pubkey, row.itemId);
  });

  /** Shared by every adapter; adapter-specific wrappers below shape their own result into this row. */
  function upsertRow(row) {
    upsertTxn({
      mediaUrl: null,
      mediaType: null,
      thumbnailUrl: null,
      blurhash: null,
      thumbhash: null,
      hashtags: null,
      contentWarning: null,
      postedAt: null,
      seenRelays: null,
      ...row,
    });
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
   * @param {string[]} [seenRelays] - relay URLs that delivered the manifest event (see relayTracking.js); omit/empty to leave whatever was already stored untouched
   */
  function upsertNsite(resolved, fetched = {}, nip05 = null, seenRelays = []) {
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
      postedAt: resolved.postedAt ?? null,
      title: fetched.title ?? existing?.title ?? resolved.title ?? null,
      description: fetched.description ?? existing?.description ?? resolved.description ?? null,
      // NsiteAdapter.fetchAndExtract() returns extractDocument()'s own
      // field name, `text` (see test/nsite-adapter.test.js), not `body` --
      // crawl.js's NCC-02/05 path renames the same field at its own call
      // site (`fetched.body = doc.text`) before calling upsertService; this
      // path never did, so a fetched nsite's page content was silently
      // never indexed into FTS, searchable only by its title/description.
      body: fetched.text ?? null,
      thumbnailUrl: fetched.image ?? null,
      seenRelays: seenRelays.length ? JSON.stringify(seenRelays) : null,
    });
  }

  /**
   * Articles (NIP-23), pictures (NIP-68) and videos (NIP-71) -- unlike
   * NCC-02/nsite, the indexable content (markdown body, caption, imeta alt
   * text) is already inline in the event, so there is no separate
   * fetch/verify step and no `fetched` argument: `resolved` already IS the
   * final record. `lastStatus`/`lastReachableAt` are deliberately left null
   * here, not "200/now" -- this backend never fetches the media bytes
   * themselves (see src/adapters/media.js), so it has no reachability claim
   * to make; the browser checks that client-side (see ui/'s media worker).
   *
   * @param {import('./adapters/article.js').ResolvedArticle | import('./adapters/media.js').ResolvedMedia} resolved
   * @param {string|null} [nip05] verified `name@domain`, or null if absent/unverifiable
   * @param {string[]} [seenRelays] - relay URLs that delivered this event (see relayTracking.js); omit/empty to leave whatever was already stored untouched
   */
  function upsertContent(resolved, nip05 = null, seenRelays = []) {
    const now = Math.floor(Date.now() / 1000);
    upsertRow({
      pubkey: resolved.pubkey,
      itemId: resolved.itemId,
      kind: resolved.kind,
      npub: safeNpub(resolved.pubkey),
      nip05,
      endpoint: resolved.endpoint ?? null,
      fingerprint: null,
      family: null,
      anchored: 0,
      usedFallback: 0,
      attestationCount: 0,
      isRevoked: 0,
      ttlSeconds: null,
      lastResolvedAt: now,
      lastReachableAt: null,
      lastStatus: null,
      lastError: null,
      title: resolved.title ?? null,
      description: resolved.description ?? null,
      body: resolved.body ?? null,
      mediaUrl: resolved.mediaUrl ?? null,
      mediaType: resolved.mediaType ?? null,
      thumbnailUrl: resolved.thumbnailUrl ?? null,
      blurhash: resolved.blurhash ?? null,
      thumbhash: resolved.thumbhash ?? null,
      hashtags:
        resolved.hashtags && resolved.hashtags.length ? JSON.stringify(resolved.hashtags) : null,
      contentWarning: resolved.contentWarning ?? null,
      postedAt: resolved.postedAt ?? null,
      seenRelays: seenRelays.length ? JSON.stringify(seenRelays) : null,
    });
  }

  const setNip05ForPubkeyStmt = db.prepare(
    `UPDATE services SET nip05 = ? WHERE pubkey = ? AND (nip05 IS NULL OR nip05 != ?)`,
  );
  const itemIdsForPubkeyStmt = db.prepare(`SELECT item_id AS "itemId" FROM services WHERE pubkey = ?`);

  /**
   * Attaches a verified NIP-05 handle to every row already indexed for a
   * pubkey, across every adapter (NCC service, nsite, article, image,
   * video) -- there's nothing content-type-specific about whose NIP-05
   * claim is whose. Used by content-crawl.js; nsite-crawl.js currently
   * does this itself by iterating its own in-memory event map, but could
   * be simplified to call this instead.
   * @param {string} pubkey
   * @param {string} nip05
   */
  const attachNip05Txn = db.transaction((pubkey, nip05) => {
    setNip05ForPubkeyStmt.run(nip05, pubkey, nip05);
    for (const { itemId } of itemIdsForPubkeyStmt.all(pubkey)) {
      syncFts(pubkey, itemId);
    }
  });
  function attachNip05(pubkey, nip05) {
    attachNip05Txn(pubkey, nip05);
  }

  // Records from one publisher with the same kind, title and description
  // (e.g. an nsite published under two site names) are the same thing to a
  // searcher. search() keeps the best-ranked one and lists the others as
  // `alternates` so they stay reachable. Rows with neither title nor
  // description are never merged -- there is nothing to say they match.
  const alternatesStmt = db.prepare(
    `SELECT item_id AS "itemId", kind FROM services
     WHERE pubkey = ? AND kind = ? AND title IS ? AND description IS ? AND item_id != ?
     ORDER BY item_id`,
  );

  // How the result page is ordered. `relevance` is the FTS/bm25 order this
  // backend has always used; the others are what the UI's sort control asks
  // for. Every order ends with a unique key (pubkey, itemId) so `LIMIT/
  // OFFSET` paging stays stable within a query -- without a tiebreak, two
  // rows with the same date or title could swap places between pages and a
  // result would appear twice or not at all.
  //
  // "No date" rows (profiles, NCC-02/05 services, rows indexed before
  // `posted_at` existed) always sort last in both directions rather than
  // first in ascending order, where they would be indistinguishable from
  // genuinely oldest content.
  const SORT_ORDERS = {
    relevance: 'rank - boost, itemId',
    newest: 'postedAt IS NULL, postedAt DESC, pubkey, itemId',
    oldest: 'postedAt IS NULL, postedAt ASC, pubkey, itemId',
    title: `(title IS NULL OR title = ''), lower(title), pubkey, itemId`,
    'title-desc': `(title IS NULL OR title = ''), lower(title) DESC, pubkey, itemId`,
  };

  function search(query, limit = 20, offset = 0, sort = 'relevance') {
    const matchQuery = buildMatchQuery(query);
    if (!matchQuery) return [];
    const orderBy = SORT_ORDERS[sort] ?? SORT_ORDERS.relevance;
    const rows = db
      .prepare(
        `WITH matches AS MATERIALIZED (
           SELECT s.pubkey, s.npub, s.nip05, s.item_id AS "itemId", s.kind, s.endpoint,
                  s.anchored, s.attestation_count AS "attestationCount",
                  s.last_reachable_at AS "lastReachableAt", s.last_status AS "lastStatus",
                  s.title, s.description,
                  s.last_resolved_at * 1000 AS "indexedAt",
                  s.posted_at * 1000 AS "postedAt",
                  s.media_url AS "mediaUrl", s.media_type AS "mediaType",
                  s.thumbnail_url AS "thumbnailUrl",
                  s.blurhash, s.thumbhash, s.hashtags,
                  s.content_warning AS "contentWarning",
                  snippet(services_fts, 5, '[', ']', '…', 12) AS snippet,
                  bm25(services_fts, 0, 0, 30.0, 8.0, 5.0, 1.0) AS rank,
                  -- A small tiebreak, not a reranking signal: subtracted
                  -- from the rank column (where more negative is better,
                  -- per bm25() above) so it only nudges ordering among otherwise-close
                  -- text matches, never overrides a clearly stronger one.
                  -- Three cheap, already-indexed proxies for "this result is
                  -- worth trusting more" -- a verified anchor, independent
                  -- attestations, and having answered recently.
                  (
                    s.anchored * 1.5
                    + CASE
                        WHEN s.attestation_count >= 5 THEN 2.0
                        WHEN s.attestation_count >= 1 THEN 1.0
                        ELSE 0
                      END
                    + CASE
                        WHEN s.last_reachable_at IS NOT NULL
                             AND s.last_reachable_at > (strftime('%s', 'now') - 86400)
                        THEN 1.0
                        ELSE 0
                      END
                  ) AS boost
           FROM services_fts f
           JOIN services s ON s.pubkey = f.pubkey AND s.item_id = f.item_id
           WHERE services_fts MATCH ?
         ), ranked AS (
           SELECT *, ROW_NUMBER() OVER (
             PARTITION BY pubkey, kind,
               CASE WHEN title IS NULL AND description IS NULL THEN itemId ELSE '' END,
               title, description
             ORDER BY rank - boost, itemId
           ) AS dupeRank
           FROM matches
         )
         SELECT * FROM ranked WHERE dupeRank = 1
         ORDER BY ${orderBy}
         LIMIT ? OFFSET ?`,
      )
      .all(matchQuery, limit, offset);
    return rows.map(({ rank, boost, dupeRank, ...row }) => ({
      ...row,
      hashtags: parseHashtags(row.hashtags),
      alternates:
        row.title == null && row.description == null
          ? []
          : alternatesStmt.all(row.pubkey, row.kind, row.title, row.description, row.itemId),
    }));
  }

  // --- posted_at backfill ----------------------------------------------------
  // Rows indexed before `posted_at` existed have no posting date, and
  // discovery will not revisit them on its own: it resumes from per-relay
  // cursors, so an old event is only re-delivered if its author replaces it.
  // src/backfillPostedAt.js walks these rows in primary-key order and asks
  // relays for the source events. These are maintenance helpers, not part of
  // the read path -- the read-only store does not export them.
  const BACKFILL_KINDS = [
    KIND_ARTICLE,
    KIND_IMAGE,
    KIND_VIDEO,
    KIND_NSITE_ROOT,
    KIND_NSITE_NAMED,
    KIND_NPACK,
  ];
  const backfillKindPlaceholders = BACKFILL_KINDS.map(() => '?').join(', ');
  const missingPostedAtStmt = db.prepare(`
    SELECT pubkey, item_id AS "itemId", kind FROM services
    WHERE posted_at IS NULL
      AND kind IN (${backfillKindPlaceholders})
      AND (pubkey > ? OR (pubkey = ? AND item_id > ?))
    ORDER BY pubkey, item_id
    LIMIT ?`);
  const countMissingPostedAtStmt = db.prepare(`
    SELECT COUNT(*) AS count FROM services
    WHERE posted_at IS NULL AND kind IN (${backfillKindPlaceholders})`);
  const setPostedAtStmt = db.prepare(
    `UPDATE services SET posted_at = ? WHERE pubkey = ? AND item_id = ? AND posted_at IS NULL`,
  );
  // One transaction per author rather than one per row: the backfill is a
  // second writer next to a live crawler, and every extra lock acquisition is
  // another chance to wait on (or, without a busy handler, lose to) it.
  const setPostedAtBatchTxn = db.transaction((entries) => {
    let changed = 0;
    for (const entry of entries) {
      changed += setPostedAtStmt.run(entry.postedAt, entry.pubkey, entry.itemId).changes;
    }
    return changed;
  });

  /**
   * One page of rows still missing a posting date, ordered by primary key.
   * `cursor` is the last row of the previous page; paging this way (rather
   * than OFFSET) keeps making progress even as rows above the cursor are
   * filled in, and rows a relay cannot resolve are simply skipped for good
   * once the cursor has passed them.
   */
  function listMissingPostedAt(cursor = null, limit = 200) {
    return missingPostedAtStmt.all(
      ...BACKFILL_KINDS,
      cursor?.pubkey ?? '',
      cursor?.pubkey ?? '',
      cursor?.itemId ?? '',
      limit,
    );
  }

  /** @returns {number} rows changed (0 when the row already had a date) */
  function setPostedAt(pubkey, itemId, postedAt) {
    return setPostedAtStmt.run(postedAt, pubkey, itemId).changes;
  }

  /**
   * Same write, many rows, one transaction. The backfill only needs this; a
   * row that already has a date is still skipped, so a crawl that resolved the
   * same row in the meantime wins either way.
   * @param {Array<{ pubkey: string, itemId: string, postedAt: number }>} entries
   * @returns {number} rows changed
   */
  function setPostedAtBatch(entries) {
    return entries.length === 0 ? 0 : setPostedAtBatchTxn(entries);
  }

  function countMissingPostedAt() {
    return countMissingPostedAtStmt.get(...BACKFILL_KINDS).count;
  }

  function getService(pubkey, itemId) {
    const row = db.prepare(`SELECT * FROM services WHERE pubkey = ? AND item_id = ?`).get(pubkey, itemId);
    return row ? { ...row, hashtags: parseHashtags(row.hashtags) } : row;
  }

  function listNip65AuthorsToCheck(limit = 5, olderThanSeconds = 7 * 24 * 60 * 60) {
    const cutoff = Math.floor(Date.now() / 1000) - olderThanSeconds;
    return db.prepare(`SELECT DISTINCT services.pubkey AS pubkey
      FROM services LEFT JOIN nip65_author_checks USING (pubkey)
      WHERE nip65_author_checks.checked_at IS NULL OR nip65_author_checks.checked_at < ?
      ORDER BY COALESCE(nip65_author_checks.checked_at, 0), services.pubkey LIMIT ?`)
      .all(cutoff, limit).map((row) => row.pubkey);
  }

  function saveNip65RelayList(pubkey, createdAt, relays) {
    db.prepare(`INSERT INTO nip65_relay_lists (pubkey, created_at, relays) VALUES (?, ?, ?)
      ON CONFLICT (pubkey) DO UPDATE SET created_at = excluded.created_at, relays = excluded.relays
      WHERE excluded.created_at >= nip65_relay_lists.created_at`)
      .run(pubkey, createdAt, JSON.stringify(relays));
  }

  function markNip65AuthorChecked(pubkey, checkedAt = Math.floor(Date.now() / 1000)) {
    db.prepare(`INSERT INTO nip65_author_checks (pubkey, checked_at) VALUES (?, ?)
      ON CONFLICT (pubkey) DO UPDATE SET checked_at = excluded.checked_at`)
      .run(pubkey, checkedAt);
  }

  function listNip65RelayCandidates({ now = Math.floor(Date.now() / 1000), maxAgeSeconds = 90 * 24 * 60 * 60 } = {}) {
    const rows = db.prepare(`SELECT lists.pubkey AS pubkey, lists.relays AS relays
      FROM nip65_relay_lists AS lists
      WHERE lists.created_at >= ? AND EXISTS (
        SELECT 1 FROM services WHERE services.pubkey = lists.pubkey
      )`)
      .all(now - maxAgeSeconds);
    const authorsByRelay = new Map();
    for (const row of rows) {
      let relays;
      try { relays = JSON.parse(row.relays); } catch { continue; }
      for (const relay of relays) {
        if (!authorsByRelay.has(relay)) authorsByRelay.set(relay, new Set());
        authorsByRelay.get(relay).add(row.pubkey);
      }
    }
    return [...authorsByRelay].map(([url, authors]) => ({ url, authorCount: authors.size }))
      .sort((a, b) => b.authorCount - a.authorCount || a.url.localeCompare(b.url));
  }

  function listLearnedRelays() {
    return db.prepare(`SELECT url, promoted_at AS promotedAt, last_probe_at AS lastProbeAt, last_error AS lastError FROM learned_relays ORDER BY promoted_at`)
      .all();
  }

  function saveLearnedRelay(url) {
    db.prepare(`INSERT OR IGNORE INTO learned_relays (url, promoted_at) VALUES (?, ?)`)
      .run(url, Math.floor(Date.now() / 1000));
  }

  function recordLearnedRelayProbe(url, error = null) {
    db.prepare(`UPDATE learned_relays SET last_probe_at = ?, last_error = ? WHERE url = ?`)
      .run(Math.floor(Date.now() / 1000), error, url);
  }

  function removeLearnedRelay(url) {
    db.prepare(`DELETE FROM learned_relays WHERE url = ?`).run(url);
  }

  function listRelayCandidateProbes() {
    return db.prepare(`SELECT url, last_probe_at AS lastProbeAt, last_error AS lastError FROM relay_candidate_probes`).all();
  }

  function recordRelayCandidateProbe(url, error = null) {
    db.prepare(`INSERT INTO relay_candidate_probes (url, last_probe_at, last_error) VALUES (?, ?, ?)
      ON CONFLICT (url) DO UPDATE SET last_probe_at = excluded.last_probe_at, last_error = excluded.last_error`)
      .run(url, Math.floor(Date.now() / 1000), error);
  }

  function getDiscoveryCursor(source, relay) {
    return db.prepare(`SELECT cursor FROM discovery_cursors WHERE source = ? AND relay = ?`).get(source, relay)?.cursor ?? 0;
  }

  function saveDiscoveryCursor(source, relay, cursor) {
    db.prepare(`INSERT INTO discovery_cursors (source, relay, cursor)
      VALUES (?, ?, ?)
      ON CONFLICT (source, relay) DO UPDATE SET cursor = MAX(cursor, excluded.cursor)`)
      .run(source, relay, cursor);
  }

  function getStatus() {
    const rowsByKind = Object.fromEntries(
      db.prepare(`SELECT kind, count(*) AS count FROM services GROUP BY kind`).all().map((row) => [row.kind, row.count]),
    );
    let databaseBytes = 0;
    try { databaseBytes = statSync(dbPath).size; } catch { /* database may not exist during startup */ }
    const diskBytes = [dbPath, `${dbPath}-wal`, `${dbPath}-shm`].reduce((total, path) => {
      try { return total + statSync(path).size; } catch { return total; }
    }, 0);
    let freeBytes = null;
    try {
      const fs = statfsSync(dirname(dbPath));
      freeBytes = fs.bavail * fs.bsize;
    } catch { /* optional filesystem metric */ }
    return {
      recordCount: Object.values(rowsByKind).reduce((sum, count) => sum + count, 0),
      rowsByKind,
      storage: { databaseBytes, diskBytes, limitBytes: maxBytes || null, freeBytes },
    };
  }

  function listStale(olderThanSeconds) {
    const cutoff = Math.floor(Date.now() / 1000) - olderThanSeconds;
    return db
      .prepare(`SELECT pubkey, item_id AS "itemId", kind FROM services WHERE last_resolved_at < ?`)
      .all(cutoff);
  }

  const deleteServiceStmt = db.prepare(`DELETE FROM services WHERE pubkey = ? AND item_id = ?`);
  const lruBatchStmt = db.prepare(
    `SELECT pubkey, item_id AS "itemId" FROM services ORDER BY last_resolved_at ASC LIMIT ?`,
  );
  const deleteBatchTxn = db.transaction((rows) => {
    for (const { pubkey, itemId } of rows) {
      deleteFtsStmt.run(pubkey, itemId);
      deleteServiceStmt.run(pubkey, itemId);
    }
  });
  const PRUNE_BATCH = 100;

  /**
   * Evicts the least-recently-resolved rows (LRU on `last_resolved_at` --
   * the same timestamp every upsert/re-crawl already keeps current, so
   * there's no separate access-tracking column to maintain) until the
   * database file is back under `maxBytes`, or there's nothing left to
   * prune. Call periodically (see src/index.js); a no-op when `maxBytes` is
   * 0/omitted, the default, which leaves growth unbounded exactly as
   * before this existed.
   * @param {number} maxBytes
   */
  function pruneToFit(maxBytes) {
    if (!maxBytes) return { prunedRows: 0 };
    let prunedRows = 0;
    while (statSync(dbPath).size > maxBytes) {
      const rows = lruBatchStmt.all(PRUNE_BATCH);
      if (rows.length === 0) break; // index is already as small as its rows allow
      deleteBatchTxn(rows);
      prunedRows += rows.length;
      // Without this, the deletes above just grow SQLite's internal free
      // list -- the file on disk never actually shrinks, and this function
      // loops forever re-measuring a size that never drops.
      db.pragma('incremental_vacuum');
    }
    return { prunedRows };
  }

  // A readonly store only ever serves reads -- exporting the write helpers
  // would just move a SQLITE_READONLY failure further from its cause.
  if (readonly) {
    return { search, getService, getStatus };
  }

  return {
    db,
    upsertService,
    upsertNsite,
    upsertContent,
    attachNip05,
    search,
    getService,
    listNip65AuthorsToCheck,
    saveNip65RelayList,
    markNip65AuthorChecked,
    listNip65RelayCandidates,
    listLearnedRelays,
    saveLearnedRelay,
    recordLearnedRelayProbe,
    removeLearnedRelay,
    listRelayCandidateProbes,
    recordRelayCandidateProbe,
    getDiscoveryCursor,
    saveDiscoveryCursor,
    getStatus,
    listStale,
    pruneToFit,
    listMissingPostedAt,
    setPostedAt,
    setPostedAtBatch,
    countMissingPostedAt,
  };
}

// Turns free-typed user input into a safe FTS5 MATCH expression:
//  - the API accepts natural-language text, not FTS5 syntax. Passing raw
//    input through makes ordinary addresses and dotted names (for example
//    `user@host` and `zap.stream`) syntax errors, while strings such as
//    `title:foo` can be interpreted as column filters. Keep Unicode
//    letters, numbers and underscores as terms, quote each one, and AND
//    them together so punctuation becomes a harmless token boundary.
//  - the last term gets a trailing `*`, turning it into a prefix query
//    (FTS5's documented `"term"*` syntax) so results start appearing before
//    the user finishes typing the final word -- e.g. "wall" already matches
//    "wallet".
function buildMatchQuery(query) {
  const terms = String(query ?? '').match(/[\p{L}\p{N}_]+/gu) ?? [];
  if (terms.length === 0) return null;
  return terms.map((term, i) => `"${term}"${i === terms.length - 1 ? '*' : ''}`).join(' AND ');
}

function safeNpub(hexPubkey) {
  try {
    return nip19.npubEncode(hexPubkey);
  } catch {
    return null;
  }
}

function parseHashtags(value) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
