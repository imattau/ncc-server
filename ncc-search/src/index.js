import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { SimplePool } from 'nostr-tools';
import { config } from './config.js';
import { openStore } from './store.js';
import { startCrawler } from './crawl.js';
import { startNsiteCrawler } from './adapters/nsite-crawl.js';
import { Nip50Adapter } from './adapters/nip50.js';
import { createServer } from './server.js';

mkdirSync(dirname(config.dbPath), { recursive: true });

const store = openStore(config.dbPath);
// One pool, shared by every adapter, so they reuse the same relay
// connections instead of each opening its own.
const pool = new SimplePool();

const nccCrawler = startCrawler(config, store, pool);
const nsiteCrawler = config.enableNsite ? startNsiteCrawler(config, store, pool) : null;
const nip50Adapter = config.enableNip50
  ? new Nip50Adapter(pool, config, { nccCrawler, nsiteCrawler })
  : null;

const app = createServer(store, nip50Adapter);

app
  .listen({ host: config.httpHost, port: config.httpPort })
  .then(() => {
    console.log(`ncc-search listening on http://${config.httpHost}:${config.httpPort}`);
    console.log(`ncc-search crawling relays: ${config.relays.join(', ')}`);
    console.log(`ncc-search nsite adapter: ${config.enableNsite ? 'enabled' : 'disabled'}`);
    console.log(`ncc-search NIP-50 live search: ${config.enableNip50 ? 'enabled' : 'disabled'}`);
  })
  .catch((err) => {
    console.error('ncc-search failed to start:', err);
    process.exit(1);
  });

function shutdown() {
  nccCrawler.stop();
  nsiteCrawler?.stop();
  pool.close(config.relays);
  app.close().finally(() => process.exit(0));
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
