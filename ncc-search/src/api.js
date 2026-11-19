// Read-only API entrypoint: GET /search, /services/:pubkey/:itemId, /status,
// /health.
//
// The other half of the split -- discovery, resolve, fetch, extract, index,
// prune -- is src/index.js, a separate process. Both open the same SQLite
// file: this one `readonly`, which is what keeps a 1 MB cheerio parse or an
// fsync in the crawler from ever landing on the request path (see README.md
// "Two processes"). WAL is what makes sharing the file safe: one writer,
// many readers, readers see committed transactions immediately.
//
// This process opens no crawl subscriptions and writes no rows. It does own
// a relay pool, for the one relay operation that belongs on a request: the
// NIP-50 live fan-out (src/adapters/nip50.js). Hits found there are POSTed
// to the crawler's ingest endpoint so they still go through full
// resolve/fetch/verify -- nothing here promotes a live hit into the index.

import { config } from './config.js';
import { openStore } from './store.js';
import { createPool, closePool } from './pool.js';
import { Nip50Adapter } from './adapters/nip50.js';
import { createServer } from './server.js';
import { createCrawlerClient, createIngestForwarder } from './crawlerClient.js';

const OPEN_RETRY_MS = 2000;
const OPEN_RETRY_ATTEMPTS = 60;

/**
 * The crawler creates the schema and may still be starting when this process
 * comes up (compose's `depends_on` only waits for the container, not for the
 * database). Retry instead of crash-looping, and say why at most once.
 */
async function openReadStore() {
  let warned = false;
  for (let attempt = 1; attempt <= OPEN_RETRY_ATTEMPTS; attempt++) {
    try {
      return openStore(config.dbPath, { readonly: true, maxBytes: config.dbMaxBytes });
    } catch (err) {
      if (!warned) {
        console.warn(
          `[ncc-search-api] index not readable yet (${err.message}); waiting for the crawler to create ${config.dbPath}`,
        );
        warned = true;
      }
      await new Promise((resolve) => setTimeout(resolve, OPEN_RETRY_MS));
    }
  }
  throw new Error(`index at ${config.dbPath} was still unreadable after ${OPEN_RETRY_ATTEMPTS} attempts`);
}

const store = await openReadStore();
const crawler = createCrawlerClient({ baseUrl: config.crawlerUrl, timeoutMs: 1000 });
const pool = createPool();
const nip50Adapter = config.enableNip50
  ? new Nip50Adapter(pool, config, createIngestForwarder(crawler))
  : null;

const app = createServer(store, nip50Adapter, {
  corsOrigin: config.corsOrigin,
  statusSource: () => crawler.status(),
  allowClientRelays: config.allowClientRelays,
  maxClientRelays: config.maxClientRelays,
});

app
  .listen({ host: config.httpHost, port: config.httpPort })
  .then(() => {
    console.log(`ncc-search-api listening on http://${config.httpHost}:${config.httpPort}`);
    console.log(`ncc-search-api index: ${config.dbPath} (read-only)`);
    console.log(`ncc-search-api crawler: ${config.crawlerUrl}`);
    console.log(`ncc-search-api NIP-50 live search: ${config.enableNip50 ? 'enabled' : 'disabled'}`);
    console.log(
      config.allowClientRelays
        ? `ncc-search-api client relay fan-out: enabled (max ${config.maxClientRelays})`
        : 'ncc-search-api client relay fan-out: disabled',
    );
  })
  .catch((err) => {
    console.error('ncc-search-api failed to start:', err);
    process.exit(1);
  });

function shutdown() {
  closePool(pool);
  app.close().finally(() => process.exit(0));
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
