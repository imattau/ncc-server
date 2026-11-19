import type { NostrEvent } from '@nostrify/nostrify';

import { normalizeRelays } from '@/lib/local/settings';

export const KIND_RELAY_LIST = 10002; // NIP-65

/**
 * The read relays from a NIP-65 kind:10002 event.
 *
 * An `r` tag with no marker means the relay is used for both reading and
 * writing; `write` marks a relay this page should not query. The values are
 * normalised with the same validator the local settings use, which also caps
 * the list at six so a browser crawl stays bounded.
 */
export function readRelaysFromEvent(event: NostrEvent | null | undefined): string[] {
  if (!event || event.kind !== KIND_RELAY_LIST) return [];
  const values: string[] = [];
  for (const tag of event.tags) {
    if (tag[0] !== 'r' || typeof tag[1] !== 'string' || !tag[1].trim()) continue;
    const marker = tag[2];
    if (marker && marker !== 'read') continue;
    values.push(tag[1]);
  }
  return normalizeRelays(values);
}

/** The newest relay list among whatever the relays returned. */
export function newestRelayList(events: NostrEvent[]): NostrEvent | null {
  let newest: NostrEvent | null = null;
  for (const event of events) {
    if (event.kind !== KIND_RELAY_LIST) continue;
    if (!newest || event.created_at > newest.created_at) newest = event;
  }
  return newest;
}
