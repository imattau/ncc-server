import 'dotenv/config';

function listEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export const config = {
  relays: listEnv('NCC_SEARCH_RELAYS', [
    'wss://relay.primal.net',
    'wss://relay.damus.io',
  ]),
  // A crawler is flagged `incomplete` (the UI's "results may be incomplete"
  // banner) only when no relay is connected or it has not synced within this
  // many ms. A single dead relay among several is diagnostic only.
  crawlStaleMs: Number(process.env.NCC_SEARCH_CRAWL_STALE_MS || 6 * 60 * 60_000),
  dbPath: process.env.NCC_SEARCH_DB_PATH || './data/ncc-search.db',
  // A disk-space ceiling for the index (store.js's `pruneToFit`), in bytes.
  // 0/unset (the default) means unbounded, unchanged from before this
  // existed -- the operator opts in by setting a byte count, e.g.
  // `500000000` for ~500MB. Enforced on a timer in index.js by evicting the
  // least-recently-resolved rows (LRU) first.
  dbMaxBytes: Number(process.env.NCC_SEARCH_DB_MAX_BYTES || 0),
  httpHost: process.env.NCC_SEARCH_HTTP_HOST || '127.0.0.1',
  httpPort: Number(process.env.NCC_SEARCH_HTTP_PORT || 7780),
  // The crawler process's private listener (src/internal.js): the API reads
  // crawl health from it and forwards NIP-50 discoveries to it. Never
  // published -- see compose.yaml, which gives the crawler container no
  // `ports:` at all.
  internalHost: process.env.NCC_SEARCH_INTERNAL_HOST || '127.0.0.1',
  internalPort: Number(process.env.NCC_SEARCH_INTERNAL_PORT || 7781),
  // Where the API process (src/api.js) finds that listener. Unset means the
  // two entrypoints are running on the same host (systemd split, dev); the
  // compose stack overrides it with the crawler service name.
  crawlerUrl: process.env.NCC_SEARCH_CRAWLER_URL || `http://127.0.0.1:${Number(process.env.NCC_SEARCH_INTERNAL_PORT || 7781)}`,
  torSocks: process.env.NCC_SEARCH_TOR_SOCKS || 'socks5h://127.0.0.1:9050',
  trustedCAPubkeys: listEnv('NCC_SEARCH_TRUSTED_CA_PUBKEYS', []),
  tickIntervalMs: Number(process.env.NCC_SEARCH_TICK_MS || 15000),
  fetchTimeoutMs: Number(process.env.NCC_SEARCH_FETCH_TIMEOUT_MS || 10000),
  fetchMaxBytes: Number(process.env.NCC_SEARCH_FETCH_MAX_BYTES || 1_000_000),
  enableNsite: process.env.NCC_SEARCH_ENABLE_NSITE !== 'false',
  // Also discover NIP-23 articles and NIP-68/71 pictures/videos. Unlike
  // nsite/NCC-02, these need no fetch/verify step at all (the indexable
  // content is already inline in the event), so there's no reachability or
  // integrity check to disable independently -- one flag covers all three.
  enableContent: process.env.NCC_SEARCH_ENABLE_CONTENT !== 'false',
  // Also discover kind:0 Nostr profiles, surfaced in ui/'s dedicated
  // "Profiles" grid tab. No fetch/verify step either (see
  // adapters/profile.js); only the NIP-05 enrichment pass costs anything
  // extra, same as nsite/article/media already pay.
  enableProfiles: process.env.NCC_SEARCH_ENABLE_PROFILES !== 'false',
  // Also discover npack (github.com/imattau/npack) package releases
  // (kind:9900 + their kind:1063 NIP-94 artifact metadata). See
  // adapters/npack.js.
  enableNpack: process.env.NCC_SEARCH_ENABLE_NPACK !== 'false',
  // Learn additional crawl relays from NIP-65 lists published by authors
  // already present in the index. Configured relays remain the bootstrap set.
  learnRelays: process.env.NCC_SEARCH_LEARN_RELAYS !== 'false',
  // Live-query configured relays that advertise NIP-50 at search time, in
  // addition to serving from the local index. On by default like nsite:
  // if none of the configured relays support it (the common case today),
  // this costs one cached NIP-11 probe per relay and nothing per search.
  enableNip50: process.env.NCC_SEARCH_ENABLE_NIP50 !== 'false',
  // Passed straight to @fastify/cors's `origin` option. `true` (default)
  // reflects whatever Origin the browser sends -- fine for this
  // unauthenticated, read-only search API (see server.js). Set to a
  // specific origin string (or comma-separated list) to restrict it once
  // ui/ has a fixed deployed origin.
  corsOrigin: process.env.NCC_SEARCH_CORS_ORIGIN
    ? listEnv('NCC_SEARCH_CORS_ORIGIN', [])
    : true,
};
