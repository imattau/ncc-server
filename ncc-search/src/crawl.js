// Orchestrates: discovery -> anchored resolution -> fetch -> extract -> store.
// Re-crawl cadence is driven by each service's own NCC-05 TTL rather than a
// fixed schedule, so the index doesn't go stale between relay-publish cycles
// but also doesn't hammer endpoints faster than their own freshness window.

import { AnchoredResolver } from './resolver.js';
import { discoverServiceRecords } from './discovery.js';
import { fetchResolvedEndpoint } from './fetcher.js';
import { extractDocument } from './extract.js';

const MIN_RECRAWL_MS = 5 * 60_000;
const DEFAULT_RECRAWL_MS = 30 * 60_000;

/**
 * @param {import('./config.js').config} config
 * @param {ReturnType<typeof import('./store.js').openStore>} store
 * @param {import('nostr-tools').SimplePool} pool shared across adapters so
 *   every one of them reuses the same relay connections rather than each
 *   opening its own.
 */
export function startCrawler(config, store, pool) {
  const resolver = new AnchoredResolver(config.relays, pool, {
    trustedCAPubkeys: config.trustedCAPubkeys,
  });

  /** @type {Map<string, number>} key -> next-eligible-at (ms epoch) */
  const pending = new Map();

  function key(pubkey, serviceId) {
    return `${pubkey}\u0000${serviceId}`;
  }

  function schedule(pubkey, serviceId, delayMs = 0) {
    const k = key(pubkey, serviceId);
    const at = Date.now() + delayMs;
    const existing = pending.get(k);
    if (existing === undefined || at < existing) pending.set(k, at);
  }

  /**
   * Schedules (pubkey, serviceId) for immediate processing from a raw
   * `kind:30059` event. Shared by the ambient relay subscription below and
   * by adapters/nip50.js's live search results -- a NIP-50 hit is just
   * another way of learning about a service record, not a different kind
   * of candidate, so it goes through the exact same resolve/fetch/verify
   * pipeline rather than being trusted as-is.
   * @param {object} event
   */
  function ingestEvent(event) {
    const serviceId = event.tags.find((t) => t[0] === 'd')?.[1];
    if (!serviceId) return;
    schedule(event.pubkey, serviceId, 0);
  }

  const discovery = discoverServiceRecords(pool, config.relays, ({ pubkey, serviceId }) => {
    schedule(pubkey, serviceId, 0);
  });

  async function processOne(pubkey, serviceId) {
    const resolved = await resolver.resolveService(pubkey, serviceId);

    let fetched = {};
    if (resolved.endpoint && !resolved.isRevoked) {
      try {
        const page = await fetchResolvedEndpoint(resolved.endpoint, {
          expectedFingerprint: resolved.fingerprint,
          timeoutMs: config.fetchTimeoutMs,
          maxBytes: config.fetchMaxBytes,
          torSocksUrl: config.torSocks,
        });
        fetched.status = page.statusCode;
        if (page.contentType.includes('html')) {
          const doc = extractDocument(page.body);
          fetched.title = doc.title;
          fetched.description = doc.description;
          fetched.body = doc.text;
        }
      } catch (err) {
        fetched.error = String(err && err.message ? err.message : err);
      }
    } else if (resolved.isRevoked) {
      fetched.error = 'anchor revoked';
    } else {
      fetched.error = resolved.anchorError || resolved.locatorError || 'no resolvable endpoint';
    }

    store.upsertService(resolved, fetched);

    const ttlMs = resolved.ttlSeconds ? resolved.ttlSeconds * 1000 : DEFAULT_RECRAWL_MS;
    schedule(pubkey, serviceId, Math.max(ttlMs, MIN_RECRAWL_MS));
  }

  async function tick() {
    const now = Date.now();
    for (const [k, at] of pending) {
      if (at > now) continue;
      pending.delete(k);
      const [pubkey, serviceId] = k.split('\u0000');
      processOne(pubkey, serviceId).catch((err) => {
        console.error(`[ncc-search] crawl failed for ${pubkey} ${serviceId}:`, err);
      });
    }
  }

  const interval = setInterval(tick, config.tickIntervalMs);

  return {
    resolver,
    ingestEvent,
    stop() {
      clearInterval(interval);
      discovery.close();
      resolver.close();
    },
  };
}
