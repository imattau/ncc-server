// Crawler/indexer entrypoint: discovery, anchored resolution, fetch, extract,
// store, prune, NIP-65 relay learning.
//
// This is the only writer of the index. It serves no public route: the API
// (src/api.js) is a separate, read-only process over the same SQLite file
// (WAL -- see README.md "Two processes"). What this process does expose is a
// private listener (src/internal.js) carrying the two things that can only
// live here: the in-memory crawl/relay health snapshot, and the ingest entry
// point the API forwards NIP-50 live-search hits to.

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from './config.js';
import { openStore } from './store.js';
import { createPool, closePool } from './pool.js';
import { startCrawler } from './crawl.js';
import { createRelayRegistry } from './relayDiscovery.js';
import { startRelayLearning } from './relayLearning.js';
import { startNsiteCrawler } from './adapters/nsite-crawl.js';
import { startContentCrawler } from './adapters/content-crawl.js';
import { startProfileCrawler } from './adapters/profile-crawl.js';
import { startNpackCrawler } from './adapters/npack-crawl.js';
import { createInternalServer } from './internal.js';
import { createCrawlMonitor } from './crawlMonitor.js';

mkdirSync(dirname(config.dbPath), { recursive: true });

const store = openStore(config.dbPath, { maxBytes: config.dbMaxBytes });
const crawlMonitor = createCrawlMonitor({ staleAfterMs: config.crawlStaleMs });
config.crawlMonitor = crawlMonitor;
config.relayRegistry = createRelayRegistry(config.relays);

// Enforced on the same cadence as everything else's periodic work
// (config.tickIntervalMs), not its own separate timer -- pruneToFit() is
// already a single statSync() plus a no-op loop condition when the index
// is under the limit (the common case), so there's nothing to gain from
// checking less often, and one fewer interval to reason about.
let pruneTimer = null;
if (config.dbMaxBytes > 0) {
  pruneTimer = setInterval(() => {
    const { prunedRows } = store.pruneToFit(config.dbMaxBytes);
    if (prunedRows > 0) {
      console.log(`ncc-search pruned ${prunedRows} least-recently-resolved row(s) to stay under ${config.dbMaxBytes} bytes`);
    }
  }, config.tickIntervalMs);
}

// One pool, shared by every adapter, so they reuse the same relay
// connections instead of each opening its own. See src/pool.js for why it
// uses `ws` rather than Node's native WebSocket implementation.
const pool = createPool();

const nccCrawler = startCrawler(config, store, pool);
const nsiteCrawler = config.enableNsite ? startNsiteCrawler(config, store, pool) : null;
const contentCrawler = config.enableContent ? startContentCrawler(config, store, pool) : null;
const profileCrawler = config.enableProfiles ? startProfileCrawler(config, store, pool) : null;
const npackCrawler = config.enableNpack ? startNpackCrawler(config, store, pool) : null;
const relayLearning = startRelayLearning(config, store, pool, config.relayRegistry);

const internal = createInternalServer({
  crawlMonitor,
  relayLearning,
  crawlers: { nccCrawler, nsiteCrawler, contentCrawler },
});

internal
  .listen({ host: config.internalHost, port: config.internalPort })
  .then(() => {
    console.log(`ncc-search crawler index: ${config.dbPath}`);
    console.log(`ncc-search crawler internal API on http://${config.internalHost}:${config.internalPort} (not public)`);
    console.log(`ncc-search crawling relays: ${config.relays.join(', ')}`);
    console.log(`ncc-search NIP-65 relay learning: ${config.learnRelays ? 'enabled (3 authors, max 10 learned relays)' : 'disabled'}`);
    console.log(`ncc-search nsite adapter: ${config.enableNsite ? 'enabled' : 'disabled'}`);
    console.log(`ncc-search article/media adapter: ${config.enableContent ? 'enabled' : 'disabled'}`);
    console.log(`ncc-search profile adapter: ${config.enableProfiles ? 'enabled' : 'disabled'}`);
    console.log(`ncc-search npack adapter: ${config.enableNpack ? 'enabled' : 'disabled'}`);
    console.log(
      config.dbMaxBytes > 0
        ? `ncc-search index size limit: ${config.dbMaxBytes} bytes (LRU-pruned)`
        : 'ncc-search index size limit: none (unbounded)',
    );
  })
  .catch((err) => {
    console.error('ncc-search crawler failed to start:', err);
    process.exit(1);
  });

function shutdown() {
  relayLearning.stop();
  nccCrawler.stop();
  nsiteCrawler?.stop();
  contentCrawler?.stop();
  profileCrawler?.stop();
  npackCrawler?.stop();
  if (pruneTimer) clearInterval(pruneTimer);
  closePool(pool);
  internal.close().finally(() => process.exit(0));
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
