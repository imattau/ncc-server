// Orchestrates the profile (kind:0) adapter. Same shape as content-crawl.js:
// no fetch/verify step (the indexable content -- name/about/picture -- is
// already inline in the event), so discover -> resolve -> store happens
// immediately, with a separate, slower NIP-05 enrichment pass reusing
// nsite.js's resolveNip05() directly, exactly like content-crawl.js does.

import { discoverProfiles, resolveProfile } from './profile.js';
import { resolveNip05 } from './nsite.js';
import { takeSeenRelays } from '../relayTracking.js';

const NIP05_RECHECK_MS = 6 * 60 * 60_000;

// See crawl.js's own MAX_CONCURRENT_PER_TICK comment for why this exists.
const MAX_CONCURRENT_PER_TICK = 5;

/**
 * @param {import('../config.js').config} config
 * @param {ReturnType<typeof import('../store.js').openStore>} store
 * @param {import('nostr-tools').SimplePool} pool shared with the other crawlers
 */
export function startProfileCrawler(config, store, pool) {
  /** @type {Map<string, number>} pubkey -> next nip05 recheck (ms epoch) */
  const nip05Pending = new Map();

  function scheduleNip05(pubkey, delayMs = 0) {
    const at = Date.now() + delayMs;
    const existing = nip05Pending.get(pubkey);
    if (existing === undefined || at < existing) nip05Pending.set(pubkey, at);
  }

  function ingestProfile(event) {
    const resolved = resolveProfile(event);
    if (!resolved) return;
    const existing = store.getService(resolved.pubkey, resolved.itemId);
    store.upsertContent(resolved, existing?.nip05 ?? null, takeSeenRelays(pool, event.id));
    scheduleNip05(resolved.pubkey, 0);
  }

  const profileSub = discoverProfiles(pool, config.relays, ingestProfile, { store, monitor: config.crawlMonitor });

  async function processNip05(pubkey) {
    const nip05 = await resolveNip05(pool, config.relays, pubkey, {
      timeoutMs: config.fetchTimeoutMs,
    });
    if (nip05) {
      store.attachNip05(pubkey, nip05);
    }
    scheduleNip05(pubkey, NIP05_RECHECK_MS);
  }

  async function tick() {
    const now = Date.now();
    let launched = 0;
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
    ingestProfile,
    stop() {
      clearInterval(interval);
      profileSub.close();
    },
  };
}
