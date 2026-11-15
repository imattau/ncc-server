// Orchestrates the nsite adapter: discovery -> resolve manifest -> fetch +
// verify blob -> extract -> store, plus a separate, slower NIP-05
// enrichment pass per pubkey. Mirrors crawl.js's discover/schedule/tick
// shape so the two pipelines read the same way, but nsite has no TTL field
// to drive re-crawl cadence (NIP-5A doesn't define one), so it re-crawls on
// a fixed interval instead.

import { discoverNsites, NsiteAdapter } from './nsite.js';
import { takeSeenRelays } from '../relayTracking.js';

const DEFAULT_RECRAWL_MS = 30 * 60_000;
const NIP05_RECHECK_MS = 6 * 60 * 60_000; // verified handles change rarely

// See crawl.js's own MAX_CONCURRENT_PER_TICK comment for why this exists --
// same reasoning applies here: NIP-05 resolution queries a relay for a
// kind:0 profile event (resolveNip05, via nsite.js) same as processOne's
// manifest fetch does its own relay work indirectly, and a discovery
// backfill can hand either queue dozens of due items in the same tick.
const MAX_CONCURRENT_PER_TICK = 5;

/**
 * @param {import('../config.js').config} config
 * @param {ReturnType<typeof import('../store.js').openStore>} store
 * @param {import('nostr-tools').SimplePool} pool shared with the NCC crawler
 */
export function startNsiteCrawler(config, store, pool) {
  const adapter = new NsiteAdapter(pool, config.relays, config);

  /** @type {Map<string, number>} key -> next-eligible-at (ms epoch) */
  const pending = new Map();
  /** @type {Map<string, number>} pubkey -> next nip05 recheck (ms epoch) */
  const nip05Pending = new Map();

  function key(pubkey, kind, dTag) {
    return `${pubkey}\u0000${kind}\u0000${dTag ?? ''}`;
  }

  function schedule(map, k, delayMs) {
    const at = Date.now() + delayMs;
    const existing = map.get(k);
    if (existing === undefined || at < existing) map.set(k, at);
  }

  /** @type {Map<string, object>} most recent manifest event seen per key, used by processOne */
  const eventsByKey = new Map();

  /**
   * Schedules a manifest for immediate processing from a raw `kind:15128`/
   * `35128` event, however it was learned about -- the ambient relay
   * subscription below, or adapters/nip50.js's live search results. Either
   * way the event still goes through resolveSite()/fetchAndExtract() on the
   * next tick, including the sha256 integrity check, rather than being
   * trusted as-is just because a relay's search matched it.
   * @param {object} event
   */
  function ingestEvent(event) {
    const dTag = event.tags.find((t) => t[0] === 'd')?.[1] || null;
    const k = key(event.pubkey, event.kind, dTag);
    eventsByKey.set(k, event);
    schedule(pending, k, 0);
    schedule(nip05Pending, event.pubkey, 0);
  }

  const discovery = discoverNsites(pool, config.relays, ({ event }) => ingestEvent(event), { store, monitor: config.crawlMonitor });

  async function processOne(k) {
    const event = eventsByKey.get(k);
    if (!event) return; // discovered then evicted before we got to it; next discovery repopulates it

    const resolved = adapter.resolveSite(event);
    const fetched = await adapter.fetchAndExtract(resolved);
    if (fetched.error) config.crawlMonitor?.processingFailed('nsites');
    const existing = store.getService(resolved.pubkey, resolved.siteId);
    const seenRelays = takeSeenRelays(pool, event.id);
    store.upsertNsite(resolved, fetched, existing?.nip05 ?? null, seenRelays);

    schedule(pending, k, DEFAULT_RECRAWL_MS);
  }

  async function processNip05(pubkey) {
    const nip05 = await adapter.resolveNip05For(pubkey);
    if (!nip05) {
      schedule(nip05Pending, pubkey, NIP05_RECHECK_MS);
      return;
    }
    // Attach to every nsite row already indexed for this pubkey. Passing an
    // empty `fetched` is safe: upsertNsite/upsertRow COALESCE title,
    // description and body against what's already stored, so this can't
    // blank out content from an earlier successful fetch (see store.js).
    for (const [k, event] of eventsByKey) {
      if (!k.startsWith(`${pubkey}\u0000`)) continue;
      const resolved = adapter.resolveSite(event);
      const existing = store.getService(resolved.pubkey, resolved.siteId);
      if (existing) {
        store.upsertNsite(resolved, {}, nip05);
      }
    }
    schedule(nip05Pending, pubkey, NIP05_RECHECK_MS);
  }

  async function tick() {
    const now = Date.now();
    let launched = 0;
    for (const [k, at] of pending) {
      if (launched >= MAX_CONCURRENT_PER_TICK) break;
      if (at > now) continue;
      pending.delete(k);
      processOne(k).catch((err) => {
        config.crawlMonitor?.processingFailed('nsites');
        console.error(`[ncc-search] nsite crawl failed for ${k}:`, err);
      });
      launched++;
    }
    launched = 0;
    for (const [pubkey, at] of nip05Pending) {
      if (launched >= MAX_CONCURRENT_PER_TICK) break;
      if (at > now) continue;
      nip05Pending.delete(pubkey);
      processNip05(pubkey).catch((err) => {
        console.error(`[ncc-search] nip05 check failed for ${pubkey}:`, err);
      });
      launched++;
    }
  }

  const interval = setInterval(tick, config.tickIntervalMs);

  return {
    ingestEvent,
    stop() {
      clearInterval(interval);
      discovery.close();
    },
  };
}
