import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { SimplePool } from 'nostr-tools';
import { WebSocket } from 'ws';
import { config } from './config.js';
import { openStore } from './store.js';
import { startCrawler } from './crawl.js';
import { createRelayRegistry } from './relayDiscovery.js';
import { startRelayLearning } from './relayLearning.js';
import { startNsiteCrawler } from './adapters/nsite-crawl.js';
import { startContentCrawler } from './adapters/content-crawl.js';
import { startProfileCrawler } from './adapters/profile-crawl.js';
import { startNpackCrawler } from './adapters/npack-crawl.js';
import { Nip50Adapter } from './adapters/nip50.js';
import { createServer } from './server.js';
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
class PoolWebSocket extends WebSocket {
  constructor(...args) {
    super(...args);
    // nostr-tools closes a relay socket when its connection timer expires.
    // `ws` emits an `error` when that happens before the handshake completes;
    // without a listener Node treats it as an uncaught EventEmitter error and
    // terminates the whole search process. Relay failures are already handled
    // by nostr-tools' close/error callbacks, so keep the event from crashing
    // this long-lived service.
    this.on('error', () => {});
  }
}

const pool = new SimplePool({ websocketImplementation: PoolWebSocket });
// Lets nsite-crawl.js/content-crawl.js record which relay(s) actually
// served a given event (see relayTracking.js) -- a redundancy signal: a
// record seen on only one relay is one relay outage away from becoming
// undiscoverable again, a record seen on several is not. `trackRelays`
// isn't a constructor option (checked against nostr-tools' own source);
// it's a plain field that must be set after construction.
pool.trackRelays = true;

const nccCrawler = startCrawler(config, store, pool);
const nsiteCrawler = config.enableNsite ? startNsiteCrawler(config, store, pool) : null;
const contentCrawler = config.enableContent ? startContentCrawler(config, store, pool) : null;
const profileCrawler = config.enableProfiles ? startProfileCrawler(config, store, pool) : null;
const npackCrawler = config.enableNpack ? startNpackCrawler(config, store, pool) : null;
const nip50Adapter = config.enableNip50
  ? new Nip50Adapter(pool, config, { nccCrawler, nsiteCrawler, contentCrawler })
  : null;
const relayLearning = startRelayLearning(config, store, pool, config.relayRegistry);

const app = createServer(store, nip50Adapter, { corsOrigin: config.corsOrigin, crawlMonitor, relayLearning });

app
  .listen({ host: config.httpHost, port: config.httpPort })
  .then(() => {
    console.log(`ncc-search listening on http://${config.httpHost}:${config.httpPort}`);
    console.log(`ncc-search crawling relays: ${config.relays.join(', ')}`);
    console.log(`ncc-search NIP-65 relay learning: ${config.learnRelays ? 'enabled (3 authors, max 10 learned relays)' : 'disabled'}`);
    console.log(`ncc-search nsite adapter: ${config.enableNsite ? 'enabled' : 'disabled'}`);
    console.log(`ncc-search article/media adapter: ${config.enableContent ? 'enabled' : 'disabled'}`);
    console.log(`ncc-search profile adapter: ${config.enableProfiles ? 'enabled' : 'disabled'}`);
    console.log(`ncc-search npack adapter: ${config.enableNpack ? 'enabled' : 'disabled'}`);
    console.log(`ncc-search NIP-50 live search: ${config.enableNip50 ? 'enabled' : 'disabled'}`);
    console.log(
      config.dbMaxBytes > 0
        ? `ncc-search index size limit: ${config.dbMaxBytes} bytes (LRU-pruned)`
        : 'ncc-search index size limit: none (unbounded)',
    );
  })
  .catch((err) => {
    console.error('ncc-search failed to start:', err);
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
  pool.close(config.relayRegistry.allKnown());
  app.close().finally(() => process.exit(0));
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
