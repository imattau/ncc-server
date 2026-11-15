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
  dbPath: process.env.NCC_SEARCH_DB_PATH || './data/ncc-search.db',
  httpHost: process.env.NCC_SEARCH_HTTP_HOST || '127.0.0.1',
  httpPort: Number(process.env.NCC_SEARCH_HTTP_PORT || 7780),
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
