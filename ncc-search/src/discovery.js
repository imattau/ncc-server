// Broad relay subscription that discovers (pubkey, serviceId) pairs by
// listening for public NCC-02 Service Records (kind 30059). This is the
// crawler's entry point: it does not need a pre-existing list of npubs,
// because Service Records are meant to be publicly discoverable.
//
// NCC-05 locators (kind 30058) are deliberately NOT discovered this way:
// NCC-05 is identity-first ("you must already know the pubkey"), so locators
// are only ever looked up per-service, driven by what discovery() finds here
// plus the matching `${serviceId}-locator` d-tag, via resolver.js.

export const SERVICE_RECORD_KIND = 30059;

/**
 * @param {import('nostr-tools').SimplePool} pool
 * @param {string[]} relays
 * @param {(record: { pubkey: string, serviceId: string, event: object }) => void} onRecord
 * @param {{ since?: number }} [options]
 * @returns {{ close: () => void }}
 */
export function discoverServiceRecords(pool, relays, onRecord, options = {}) {
  const filter = { kinds: [SERVICE_RECORD_KIND] };
  if (options.since) filter.since = options.since;

  // This version of nostr-tools' SimplePool.subscribeMany(relays, filter, params)
  // takes a single filter OBJECT, not an array of filters -- wrapping it in
  // `[filter]` (as older nostr-tools/NDK-style APIs expect) makes the relay
  // reject the REQ outright ("bad req: provided filter is not an object"),
  // which subscribeMany itself swallows into a oneclose callback rather than
  // throwing. Confirmed this was silently breaking every discovery filter in
  // this project by testing live against wss://relay.primal.net: zero events
  // ever arrived despite the relay demonstrably having matching data.
  const sub = pool.subscribeMany(relays, filter, {
    onevent(event) {
      const serviceId = event.tags.find((t) => t[0] === 'd')?.[1];
      if (!serviceId) return;
      onRecord({ pubkey: event.pubkey, serviceId, event });
    },
    oneose() {
      // Keep the subscription open for live updates past end-of-stored-events;
      // backfill is handled by re-running discovery with `since` on restart.
    },
  });

  return { close: () => sub.close() };
}
