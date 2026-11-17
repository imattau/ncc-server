import { NPool, NRelay1, type NostrFilter } from '@nostrify/nostrify';

import { uiRelays } from '@/lib/local/settings';

/**
 * A minimal, read-only Nostr pool for this page's own client-side extras
 * (profile lookups for display names, article previews, quoted notes). It
 * never publishes and has no login, so AUTH handling, gift-wrap verification
 * skipping, and signer wiring don't apply here.
 *
 * Relay selection is a function, not a constant: the nsite edition's settings
 * let a reader add or remove crawl relays, and names/previews should follow
 * the same list instead of the page having two unrelated relay sets. The
 * router is called per request, so a settings change applies to the next
 * query without rebuilding the pool.
 */
const FALLBACK_RELAYS = ['wss://relay.primal.net', 'wss://relay.damus.io'];

export function currentUiRelays(): string[] {
  const relays = uiRelays();
  return relays.length ? relays : FALLBACK_RELAYS;
}

export const nostrPool = new NPool({
  open(url: string) {
    return new NRelay1(url);
  },
  reqRouter(filters: NostrFilter[]) {
    return new Map(currentUiRelays().map((url: string) => [url, filters]));
  },
  eventRouter() {
    return [];
  },
});
