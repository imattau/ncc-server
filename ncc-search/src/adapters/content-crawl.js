// Orchestrates the article (NIP-23) and media (NIP-68/71) adapters. Much
// simpler than crawl.js/nsite-crawl.js: there is no fetch/verify step for
// either (see article.js's and media.js's module comments for why), so
// "crawl" here means discover -> resolve -> store immediately, with no
// pending/schedule queue at all. The ambient relay subscription alone keeps
// the index current: an addressable article update or a newly published
// picture/video arrives as its own event and is stored on arrival.
//
// NIP-05 enrichment follows the same periodic-recheck pattern nsite-crawl.js
// uses, reusing nsite.js's resolveNip05 directly rather than a second
// implementation -- there's nothing article/media-specific about verifying
// a pubkey's NIP-05 claim.

import { discoverArticles, resolveArticle } from './article.js';
import { discoverMedia, resolveMedia } from './media.js';
import { discoverEvents, resolveEvent } from './calendar.js';
import { discoverLiveStreams, resolveLiveStream } from './live.js';
import { discoverApps, resolveApp } from './app.js';
import { discoverCommunities, resolveCommunity } from './community.js';
import { resolveNip05 } from './nsite.js';
import { takeSeenRelays } from '../relayTracking.js';

const NIP05_RECHECK_MS = 6 * 60 * 60_000;

// See crawl.js's own MAX_CONCURRENT_PER_TICK comment for why this exists:
// resolveNip05 (nsite.js) queries a relay for a kind:0 profile event, and a
// discovery backfill can hand this queue dozens of newly-seen pubkeys due
// in the very same tick.
const MAX_CONCURRENT_PER_TICK = 5;

/**
 * @param {import('../config.js').config} config
 * @param {ReturnType<typeof import('../store.js').openStore>} store
 * @param {import('nostr-tools').SimplePool} pool shared with the other crawlers
 */
export function startContentCrawler(config, store, pool) {
  /** @type {Map<string, number>} pubkey -> next nip05 recheck (ms epoch) */
  const nip05Pending = new Map();

  function scheduleNip05(pubkey, delayMs = 0) {
    const at = Date.now() + delayMs;
    const existing = nip05Pending.get(pubkey);
    if (existing === undefined || at < existing) nip05Pending.set(pubkey, at);
  }

  function ingestArticle(event) {
    const resolved = resolveArticle(event);
    if (!resolved.itemId) return;
    const existing = store.getService(resolved.pubkey, resolved.itemId);
    store.upsertContent(resolved, existing?.nip05 ?? null, takeSeenRelays(pool, event.id));
    scheduleNip05(resolved.pubkey, 0);
  }

  function ingestMedia(event) {
    const resolved = resolveMedia(event);
    if (!resolved) return;
    const existing = store.getService(resolved.pubkey, resolved.itemId);
    store.upsertContent(resolved, existing?.nip05 ?? null, takeSeenRelays(pool, event.id));
    scheduleNip05(resolved.pubkey, 0);
  }

  function ingestEvent(event) {
    const resolved = resolveEvent(event);
    if (!resolved) return;
    const existing = store.getService(resolved.pubkey, resolved.itemId);
    store.upsertContent(resolved, existing?.nip05 ?? null, takeSeenRelays(pool, event.id));
    scheduleNip05(resolved.pubkey, 0);
  }

  function ingestLiveStream(event) {
    const resolved = resolveLiveStream(event);
    if (!resolved) return;
    const existing = store.getService(resolved.pubkey, resolved.itemId);
    store.upsertContent(resolved, existing?.nip05 ?? null, takeSeenRelays(pool, event.id));
    scheduleNip05(resolved.pubkey, 0);
  }

  function ingestApp(event) {
    const resolved = resolveApp(event);
    if (!resolved) return;
    const existing = store.getService(resolved.pubkey, resolved.itemId);
    store.upsertContent(resolved, existing?.nip05 ?? null, takeSeenRelays(pool, event.id));
    scheduleNip05(resolved.pubkey, 0);
  }

  function ingestCommunity(event) {
    const resolved = resolveCommunity(event);
    if (!resolved) return;
    const existing = store.getService(resolved.pubkey, resolved.itemId);
    store.upsertContent(resolved, existing?.nip05 ?? null, takeSeenRelays(pool, event.id));
    scheduleNip05(resolved.pubkey, 0);
  }

  const subscriptionOptions = { store, monitor: config.crawlMonitor, relayRegistry: config.relayRegistry };
  const articleSub = discoverArticles(pool, config.relays, ingestArticle, subscriptionOptions);
  const mediaSub = discoverMedia(pool, config.relays, ingestMedia, subscriptionOptions);
  const eventSub = config.enableEvents
    ? discoverEvents(pool, config.relays, ingestEvent, subscriptionOptions)
    : null;
  const liveSub = config.enableLive
    ? discoverLiveStreams(pool, config.relays, ingestLiveStream, subscriptionOptions)
    : null;
  // Apps are usually only carried by a store's catalog relay, so this
  // subscription adds the configured app relay(s) to the node's own relays.
  // Communities use the node's relays like every other relay-native kind.
  const appRelays = [...new Set([...config.relays, ...(config.appRelays ?? [])])];
  const appSub = config.enableApps
    ? discoverApps(pool, appRelays, ingestApp, subscriptionOptions)
    : null;
  const communitySub = config.enableCommunities
    ? discoverCommunities(pool, config.relays, ingestCommunity, subscriptionOptions)
    : null;

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
    ingestArticle,
    ingestMedia,
    ingestEvent,
    ingestLiveStream,
    ingestApp,
    ingestCommunity,
    stop() {
      clearInterval(interval);
      articleSub.close();
      mediaSub.close();
      eventSub?.close();
      liveSub?.close();
      appSub?.close();
      communitySub?.close();
    },
  };
}
