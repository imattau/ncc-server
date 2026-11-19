// NIP-11 relay information document fetch, used only to check whether a
// relay advertises NIP-50 ("search" filter field) support before bothering
// to issue a `search` REQ to it. Per NIP-50 itself: "Since this is not a
// NIP that can be 'supported' in a strict sense, clients should look at
// the relay's advertised NIP-11 document."
//
// A plain class (not a module-level singleton) so each adapter -- and each
// test -- gets its own cache rather than sharing hidden global state.

import { fetchUrl } from './fetcher.js';

const DEFAULT_CACHE_TTL_MS = 60 * 60_000; // relay capability changes rarely
// The configured relays are a fixed, small set, but /search can probe relays
// named by a request. Without a bound, a caller could grow this cache (and
// the outbound NIP-11 fetches that fill it) indefinitely.
const DEFAULT_MAX_ENTRIES = 200;

function toInfoUrl(relayUrl) {
  const url = new URL(relayUrl);
  url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
  return url.toString();
}

/**
 * Fetches and parses a relay's NIP-11 document. Returns null on any
 * failure (unreachable, non-200, unparsable) -- absence of capability info
 * is treated the same as "not supported", never as an error that blocks
 * the rest of a search.
 * @param {string} relayUrl
 * @param {{ timeoutMs?: number }} [opts]
 */
export async function fetchRelayInfo(relayUrl, opts = {}) {
  try {
    const res = await fetchUrl(toInfoUrl(relayUrl), {
      timeoutMs: opts.timeoutMs ?? 5000,
      maxBytes: 200_000,
      headers: { Accept: 'application/nostr+json' },
    });
    if (res.statusCode !== 200) return null;
    return JSON.parse(res.body);
  } catch {
    return null;
  }
}

export class Nip11Prober {
  /** @param {{ timeoutMs?: number, cacheTtlMs?: number, maxEntries?: number }} [opts] */
  constructor(opts = {}) {
    this.timeoutMs = opts.timeoutMs ?? 5000;
    this.cacheTtlMs = opts.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
    /** @type {Map<string, { supported: boolean, checkedAt: number }>} */
    this.cache = new Map();
  }

  /** @param {string} relayUrl @param {{ timeoutMs?: number }} [opts] */
  async supportsNip50(relayUrl, opts = {}) {
    const cached = this.cache.get(relayUrl);
    if (cached && Date.now() - cached.checkedAt < this.cacheTtlMs) {
      // Re-insert so Map iteration order is least-recently-used first.
      this.cache.delete(relayUrl);
      this.cache.set(relayUrl, cached);
      return cached.supported;
    }

    const info = await fetchRelayInfo(relayUrl, { timeoutMs: opts.timeoutMs ?? this.timeoutMs });
    const supported = Array.isArray(info?.supported_nips) && info.supported_nips.includes(50);
    this.cache.delete(relayUrl);
    this.cache.set(relayUrl, { supported, checkedAt: Date.now() });
    while (this.cache.size > this.maxEntries) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
    return supported;
  }

  /** @param {string[]} relays @param {{ timeoutMs?: number }} [opts] @returns {Promise<string[]>} the subset that advertise NIP-50 */
  async filterCapable(relays, opts = {}) {
    const checks = await Promise.all(relays.map(async (r) => [r, await this.supportsNip50(r, opts)]));
    return checks.filter(([, ok]) => ok).map(([r]) => r);
  }
}
