// One-off maintenance: reclassify short videos that were indexed before
// NIP-71's short-form kinds (22 / 34236) got their own row kind.
//
// Discovery resumes from per-relay cursors (relayDiscovery.js), so an old
// video is only re-delivered if its author replaces it. This walks the rows
// still marked `video`, asks the configured relays for each author's media
// events once, and changes only the rows whose source event is a short-form
// video. Normal videos, images and anything a relay cannot resolve are left
// untouched, so re-running is always safe.
//
// Run it inside the crawler container, after the image with the new kind is
// deployed:
//
//   docker-compose -p ncc-bundle exec search-crawler node src/reclassifyVideoKinds.js --dry-run
//   docker-compose -p ncc-bundle exec search-crawler node src/reclassifyVideoKinds.js
//
// SQLite's WAL mode lets it write while the crawler runs; the batch write
// retries SQLITE_BUSY like backfillPostedAt.js does.

import { config } from './config.js';
import { openStore } from './store.js';
import { createPool, closePool } from './pool.js';
import { MEDIA_KINDS, KIND_VIDEO_SHORT, storeKindFor, SHORT_VIDEO_KINDS } from './adapters/media.js';

const QUERY_TIMEOUT_MS = 8_000;
const WRITE_ATTEMPTS = 4;

function usage() {
  return [
    'Usage: node src/reclassifyVideoKinds.js [options]',
    '',
    '  --dry-run            log how many rows would change without writing',
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

/** The item id media.js keys a row on: event id for regular kinds, `d` for addressable. */
function itemIdOf(event) {
  if (event.kind === 34235 || event.kind === 34236) {
    return event.tags.find((tag) => tag[0] === 'd')?.[1] ?? null;
  }
  return event.id ?? null;
}

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

function isBusy(error) {
  return error?.code === 'SQLITE_BUSY' || error?.code === 'SQLITE_LOCKED';
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function writeKinds(store, entries) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return store.setVideoKindBatch(entries);
    } catch (error) {
      if (!isBusy(error) || attempt >= WRITE_ATTEMPTS) throw error;
      console.warn(
        `[reclassify] database busy (${error.code}), retrying ${entries.length} row(s) ` +
          `(attempt ${attempt}/${WRITE_ATTEMPTS})`,
      );
      await sleep(500 * 2 ** (attempt - 1));
    }
  }
}

const options = parseArgs(process.argv.slice(2));
const store = openStore(config.dbPath);
if (typeof store.countVideoRowsForReclassify !== 'function') {
  console.error('This build\'s store has no reclassify helpers (read-only bundle?)');
  process.exit(1);
}

const total = store.countVideoRowsForReclassify();
console.log(
  `[reclassify] ${total} row(s) marked video in ${config.dbPath}; ` +
    `${config.relays.length} relay(s), concurrency ${options.concurrency}${options.dryRun ? ', dry run' : ''}`,
);
if (total === 0) {
  console.log('[reclassify] nothing to do');
  process.exit(0);
}

const pool = createPool();
let cursor = null;
let scanned = 0;
let changed = 0;
let unresolved = 0;
let queries = 0;
let pages = 0;
let failure = null;

try {
  while (pages < options.maxPages) {
    const rows = store.listVideoRowsForReclassify(cursor, options.page);
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

    let pageChanged = 0;
    await mapLimit([...byPubkey.entries()], options.concurrency, async ([pubkey, authorRows]) => {
      const filter = { kinds: MEDIA_KINDS, authors: [pubkey], limit: 500 };
      const ask = () => withTimeout(pool.querySync(config.relays, filter), QUERY_TIMEOUT_MS);
      let events = [];
      try {
        events = await ask();
        queries += 1;
        if (events.length === 0) {
          await sleep(750);
          events = await ask();
          queries += 1;
        }
      } catch (error) {
        console.warn(`[reclassify] ${pubkey.slice(0, 8)}…: ${error.message}`);
      }

      // Only short-form media events are interesting here; everything else
      // either already has the right kind or is not a video at all.
      const shorts = new Set();
      for (const event of events) {
        if (!SHORT_VIDEO_KINDS.has(event.kind)) continue;
        const itemId = itemIdOf(event);
        if (itemId) shorts.add(itemId);
      }

      const writes = [];
      for (const row of authorRows) {
        if (!shorts.has(row.itemId)) {
          unresolved += 1;
          continue;
        }
        writes.push({
          pubkey,
          itemId: row.itemId,
          kind: storeKindFor(KIND_VIDEO_SHORT),
        });
      }
      if (writes.length === 0) return;
      pageChanged += writes.length;
      if (!options.dryRun) await writeKinds(store, writes);
    });

    changed += pageChanged;
    console.log(
      `[reclassify] page ${pages}: scanned ${scanned}/${total}, changed ${changed}, ` +
        `unresolved ${unresolved}, ${queries} relay request(s) (this page: ${pageChanged})`,
    );
  }
} catch (error) {
  failure = error;
} finally {
  closePool(pool);
  store.db.close();
}

if (failure) {
  console.error(`[reclassify] stopped: ${failure.message}`);
  console.error('[reclassify] rows changed before the failure are already stored; re-run to continue.');
  process.exit(1);
}

console.log(
  options.dryRun
    ? `[reclassify] dry run complete: ${changed} row(s) would change; nothing was written`
    : `[reclassify] done: ${changed} row(s) changed to short-video`,
);
process.exit(0);
