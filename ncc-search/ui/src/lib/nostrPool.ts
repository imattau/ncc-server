import { NPool, NRelay1, type NostrFilter } from '@nostrify/nostrify';

declare global {
  interface Window {
    NCC_SEARCH_RELAYS_B64?: string;
  }
}

const configuredRelays = window.NCC_SEARCH_RELAYS_B64
  ? atob(window.NCC_SEARCH_RELAYS_B64)
  : import.meta.env.VITE_NCC_SEARCH_RELAYS ?? '';
const RELAYS = (configuredRelays || 'wss://relay.primal.net,wss://relay.damus.io')
  .split(',')
  .map((s: string) => s.trim())
  .filter(Boolean);

/**
 * A minimal, read-only Nostr pool for this page's own client-side extras
 * (profile lookups for display names). Deliberately NOT
 * test-app/src/components/NostrProvider.tsx's full setup: this page never
 * publishes and has no login, so AUTH handling, gift-wrap verification
 * skipping, and signer wiring don't apply here.
 */
export const nostrPool = new NPool({
  open(url: string) {
    return new NRelay1(url);
  },
  reqRouter(filters: NostrFilter[]) {
    return new Map(RELAYS.map((url: string) => [url, filters]));
  },
  eventRouter() {
    return [];
  },
});

export const NOSTR_RELAYS = RELAYS;
