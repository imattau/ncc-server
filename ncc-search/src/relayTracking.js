// nostr-tools' SimplePool, when `trackRelays` is enabled (see
// src/index.js), keeps a `seenOn: Map<eventId, Set<AbstractRelay>>` entry
// for every event it has ever delivered to any subscription/query. It is
// never pruned on its own -- an entry sits there for the lifetime of this
// long-running crawler process unless something deletes it. Call this
// exactly once per event, right after resolving it into a stored record,
// and never look the same event id up again; that keeps the map's size
// bounded by "events currently in flight" rather than "every event this
// process has ever seen."
//
// Safe to call even when `trackRelays` was never turned on, or against a
// bare/fake pool (e.g. in tests) that has no `seenOn` at all -- returns an
// empty list rather than throwing, same as "no relay recorded it" would.
/**
 * @param {import('nostr-tools').SimplePool} pool
 * @param {string} eventId
 * @returns {string[]} relay URLs, sorted, deduplicated
 */
export function takeSeenRelays(pool, eventId) {
  const relays = pool.seenOn?.get(eventId);
  pool.seenOn?.delete(eventId);
  if (!relays || relays.size === 0) return [];
  return [...new Set([...relays].map((relay) => relay.url))].sort();
}
