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
  // Live-query configured relays that advertise NIP-50 at search time, in
  // addition to serving from the local index. On by default like nsite:
  // if none of the configured relays support it (the common case today),
  // this costs one cached NIP-11 probe per relay and nothing per search.
  enableNip50: process.env.NCC_SEARCH_ENABLE_NIP50 !== 'false',
};
