// One-off maintenance: fill in `posted_at` for rows indexed before that
// column existed.
//
// Discovery resumes from per-relay cursors (relayDiscovery.js), so an old
// article or picture is only re-delivered if its author replaces it -- which
// for most of the index means never. This walks the rows that still have no
// date, asks the configured relays for each author's events once, and writes
// the dates the crawler would have written had the column existed then.
//
// Run it inside the crawler container, after the image with `posted_at` is
// deployed:
//
//   docker-compose -p ncc-bundle exec search-crawler node src/backfillPostedAt.js
//
// It is safe to re-run: it only ever selects rows whose posted_at is still
// NULL, and the write is itself `... AND posted_at IS NULL`, so a date a crawl
// has stored in the meantime is never overwritten. Rows a relay cannot resolve
// stay NULL and are skipped once the cursor passes them; re-running retries
// them. SQLite's WAL mode lets it write while the crawler runs: the store's
// writer connection waits on a busy database (and the dates for one author are
// written in a single transaction) instead of failing with "database is
// locked" the first time the crawler happens to be committing a page.

import { config } from './config.js';
import { openStore } from './store.js';
import { createPool, closePool } from './pool.js';
import { postedAtOf } from './postedAt.js';

const EVENT_KINDS = [30023, 20, 21, 22, 34235, 34236, 15128, 35128, 9900];
const ADDRESSABLE_KINDS = new Set([30023, 34235, 34236, 35128, 9900]);
const QUERY_TIMEOUT_MS = 8_000;

function usage() {
  return [
    'Usage: node src/backfillPostedAt.js [options]',
    '',
    '  --dry-run            log how many rows would be filled without writing',
    '  --page=<n>           rows per database page (default 500)',
    '  --concurrency=<n>    relay queries in flight (default 4)',
    '  --max-pages=<n>      stop after n pages, for a quick partial run',
  ].join('\n');
}

function parseArgs(argv) {
  const options = { dryRun: false, page: 500, concurrency: 4, maxPages: Infinity };
  for (const arg of argv) {
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg.startsWith('--page=')) options.page = positiveInt(arg, '--page');
    else if (arg.startsWith('--concurrency=')) options.concurrency = positiveInt(arg, '--concurrency');
    else if (arg.startsWith('--max-pages=')) options.maxPages = positiveInt(arg, '--max-pages');
    else if (arg === '--help' || arg === '-h') {
      console.log(usage());
      process.exit(0);
    } else {
      console.error(`Unknown option: ${arg}\n\n${usage()}`);
      process.exit(2);
    }
  }
  return options;
}

function positiveInt(arg, name) {
  const value = Number(arg.slice(name.length + 1));
  if (!Number.isInteger(value) || value < 1) {
    console.error(`${name} expects a positive integer, got "${arg}"`);
    process.exit(2);
  }
  return value;
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('relay query timed out')), ms)),
  ]);
}

/** Row kind -> the event that produced it, and how its item_id is derived. */
function rowKeyFor(event) {
  switch (event.kind) {
    case 30023:
      return { kind: 'article', itemId: addressableId(event) };
    case 20:
      return { kind: 'image', itemId: event.id };
    case 21:
    case 22:
    case 34235:
    case 34236:
      return {
        kind: 'video',
        itemId: ADDRESSABLE_KINDS.has(event.kind) ? addressableId(event) : event.id,
      };
    case 15128:
      return { kind: 'nsite-root', itemId: '_root' };
    case 35128:
      return { kind: 'nsite-named', itemId: addressableId(event) };
    case 9900:
      return { kind: 'npack', itemId: addressableId(event) };
    default:
      return null;
  }
}

function addressableId(event) {
  return event.tags.find((tag) => tag[0] === 'd')?.[1] ?? null;
}

/** Runs `worker` over `items` with at most `limit` in flight. */
async function mapLimit(items, limit, worker) {
  let index = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const item = items[index++];
      await worker(item);
    }
  });
  await Promise.all(runners);
}

const WRITE_ATTEMPTS = 4;

function isBusy(error) {
  return error?.code === 'SQLITE_BUSY' || error?.code === 'SQLITE_LOCKED';
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Writes one author's dates in a single transaction, waiting out the crawler.
 *
 * store.js sets a ten-second busy timeout on its writer connection, which
 * covers every ordinary collision. This retry is for the case that timeout is
 * not enough -- a crawl page committing rows, a VACUUM, a checkpoint -- where
 * the alternative would be aborting a run that has already made thousands of
 * relay requests. Batches are idempotent (`... AND posted_at IS NULL`), so
 * retrying the same entries is always safe.
 */
async function writeDates(store, entries) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return store.setPostedAtBatch(entries);
    } catch (error) {
      if (!isBusy(error) || attempt >= WRITE_ATTEMPTS) throw error;
      console.warn(
        `[backfill] database busy (${error.code}), retrying ${entries.length} row(s) ` +
          `(attempt ${attempt}/${WRITE_ATTEMPTS})`,
      );
      await sleep(500 * 2 ** (attempt - 1));
    }
  }
}

const options = parseArgs(process.argv.slice(2));
const store = openStore(config.dbPath);
if (typeof store.countMissingPostedAt !== 'function') {
  console.error('This build\'s store has no backfill helpers (read-only bundle?)');
  process.exit(1);
}

const total = store.countMissingPostedAt();
console.log(
  `[backfill] ${total} content row(s) without posted_at in ${config.dbPath}; ` +
    `${config.relays.length} relay(s), concurrency ${options.concurrency}${options.dryRun ? ', dry run' : ''}`,
);
if (total === 0) {
  console.log('[backfill] nothing to do');
  process.exit(0);
}

const pool = createPool();
let cursor = null;
let scanned = 0;
let filled = 0;
let unresolved = 0;
let queries = 0;
let pages = 0;
let failure = null;

try {
  while (pages < options.maxPages) {
    const rows = store.listMissingPostedAt(cursor, options.page);
    if (rows.length === 0) break;
    const last = rows[rows.length - 1];
    cursor = { pubkey: last.pubkey, itemId: last.itemId };
    scanned += rows.length;
    pages += 1;

    const byPubkey = new Map();
    for (const row of rows) {
      const list = byPubkey.get(row.pubkey) ?? [];
      list.push(row);
      byPubkey.set(row.pubkey, list);
    }

    let pageFilled = 0;
    await mapLimit([...byPubkey.entries()], options.concurrency, async ([pubkey, authorRows]) => {
      // One request per author covers every kind this script backfills; the
      // limit is generous because it must hold everything an author has
      // published, not just the rows missing a date.
      const filter = { kinds: EVENT_KINDS, authors: [pubkey], limit: 500 };
      const ask = () => withTimeout(pool.querySync(config.relays, filter), QUERY_TIMEOUT_MS);
      let events = [];
      try {
        events = await ask();
        queries += 1;
        // A relay occasionally answers EOSE with nothing for an author it
        // definitely has (observed live against a public relay); one retry
        // keeps those rows from being reported as unresolvable.
        if (events.length === 0) {
          await new Promise((resolve) => setTimeout(resolve, 750));
          events = await ask();
          queries += 1;
        }
      } catch (error) {
        console.warn(`[backfill] ${pubkey.slice(0, 8)}…: ${error.message}`);
      }

      // Newest event wins per key: a replaced addressable event can come back
      // as several copies from different relays.
      const dates = new Map();
      for (const event of events) {
        const row = rowKeyFor(event);
        if (!row || !row.itemId) continue;
        const previous = dates.get(`${row.kind}\u0000${row.itemId}`);
        if (previous !== undefined && previous.createdAt >= event.created_at) continue;
        dates.set(`${row.kind}\u0000${row.itemId}`, {
          createdAt: event.created_at,
          postedAt: postedAtOf(event),
        });
      }

      const writes = [];
      for (const row of authorRows) {
        const hit = dates.get(`${row.kind}\u0000${row.itemId}`);
        if (!hit || hit.postedAt == null) {
          unresolved += 1;
          continue;
        }
        writes.push({ pubkey, itemId: row.itemId, postedAt: hit.postedAt });
        filled += 1;
        pageFilled += 1;
      }
      if (!options.dryRun && writes.length > 0) await writeDates(store, writes);
    });

    console.log(
      `[backfill] page ${pages}: scanned ${scanned}/${total}, filled ${filled}, ` +
        `unresolved ${unresolved}, ${queries} relay request(s) (this page: ${pageFilled})`,
    );
  }
} catch (error) {
  failure = error;
} finally {
  closePool(pool);
  store.db.close();
}

if (failure) {
  // A raw stack from better-sqlite3 says "database is locked" and nothing
  // about what to do next. Everything committed by earlier pages is already
  // in the index, and the query is idempotent, so the recovery is a re-run.
  console.error(
    `[backfill] stopped after ${pages} page(s): ${failure.message}` +
      (failure.code ? ` (${failure.code})` : ''),
  );
  console.error('[backfill] dates written so far are kept; re-run to continue where this stopped.');
  process.exit(1);
}

console.log(
  `[backfill] ${options.dryRun ? 'would fill' : 'filled'} ${filled} row(s); ` +
    `${unresolved} not found on the configured relays (re-run to retry them)`,
);
