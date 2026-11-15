import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { SimplePool } from 'nostr-tools';
import { WebSocket } from 'ws';
import { config } from './config.js';
import { openStore } from './store.js';
import { startCrawler } from './crawl.js';
import { startNsiteCrawler } from './adapters/nsite-crawl.js';
import { startContentCrawler } from './adapters/content-crawl.js';
import { Nip50Adapter } from './adapters/nip50.js';
import { createServer } from './server.js';

mkdirSync(dirname(config.dbPath), { recursive: true });

const store = openStore(config.dbPath);
// One pool, shared by every adapter, so they reuse the same relay
// connections instead of each opening its own.
//
// `websocketImplementation` is NOT cosmetic: nostr-tools' SimplePool
// defaults to Node's native (undici-based) global `WebSocket`. That
// implementation's `AbstractRelay.onerror` handler calls `this.ws.close()`
// synchronously from inside the socket's own `error` event -- which, on a
// failed/refused connection, re-enters undici's internal
// failWebsocketConnection/closeWebSocketConnection dispatch and recurses
// until the stack overflows, crashing the entire process. Reproduced this
// directly (both against an unreachable port and against a momentary error
// from a real public relay) while building the UI against this backend.
// The `ws` package (already a dependency the sidecar itself uses for the
// same reason) implements the same onopen/onmessage/onerror/onclose
// interface without that reentrancy bug, so every relay connection this
// process makes goes through it instead of the native implementation.
const pool = new SimplePool({ websocketImplementation: WebSocket });

const nccCrawler = startCrawler(config, store, pool);
const nsiteCrawler = config.enableNsite ? startNsiteCrawler(config, store, pool) : null;
const contentCrawler = config.enableContent ? startContentCrawler(config, store, pool) : null;
const nip50Adapter = config.enableNip50
  ? new Nip50Adapter(pool, config, { nccCrawler, nsiteCrawler, contentCrawler })
  : null;

const app = createServer(store, nip50Adapter, { corsOrigin: config.corsOrigin });

app
  .listen({ host: config.httpHost, port: config.httpPort })
  .then(() => {
    console.log(`ncc-search listening on http://${config.httpHost}:${config.httpPort}`);
    console.log(`ncc-search crawling relays: ${config.relays.join(', ')}`);
    console.log(`ncc-search nsite adapter: ${config.enableNsite ? 'enabled' : 'disabled'}`);
    console.log(`ncc-search article/media adapter: ${config.enableContent ? 'enabled' : 'disabled'}`);
    console.log(`ncc-search NIP-50 live search: ${config.enableNip50 ? 'enabled' : 'disabled'}`);
  })
  .catch((err) => {
    console.error('ncc-search failed to start:', err);
    process.exit(1);
  });

function shutdown() {
  nccCrawler.stop();
  nsiteCrawler?.stop();
  contentCrawler?.stop();
  pool.close(config.relays);
  app.close().finally(() => process.exit(0));
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
