// Parse and validate the optional `relays` parameter on GET /search.
//
// This is the only place a public, unauthenticated request can name a host
// the server will connect to. The rules are deliberately narrow:
//   - wss:// only, no credentials or fragment, no localhost/.local/private IP
//     literals (relayUrl.js);
//   - at most `max` distinct relays (default 3);
//   - no duplicates, and the caller dedupes against NCC_SEARCH_RELAYS before
//     querying.
//
// The relays are used read-only for the NIP-50 live fan-out: their hits are
// shown to the requesting page but never ingested into the index. An invalid
// entry is ignored rather than rejected -- one stale relay URL in a user's
// NIP-65 list should not make the whole search fail.

import { safePublicRelayUrl } from './relayUrl.js';

/**
 * @param {string|string[]|undefined|null} value - repeated query param or
 *   comma-separated string
 * @param {{ max?: number }} [options]
 * @returns {string[]}
 */
export function parseClientRelays(value, options = {}) {
  const max = Number.isFinite(options.max) && options.max > 0 ? Math.floor(options.max) : 3;
  const raw = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? [value]
      : [];

  const seen = new Set();
  const relays = [];
  for (const entry of raw) {
    for (const piece of String(entry).split(',')) {
      const url = safePublicRelayUrl(piece.trim());
      if (!url || seen.has(url)) continue;
      seen.add(url);
      relays.push(url);
      if (relays.length >= max) return relays;
    }
  }
  return relays;
}
