const CHECKPOINT_OVERLAP_SECONDS = 5 * 60;
const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 5 * 60_000;
// How long one drain turn may spend running onEvent before yielding to the
// event loop. Relay backfills (a kind:0 burst after a restart, for example)
// arrive many events per turn; running them all inline starves every timer and
// socket in the process, including the crawler's own /health listener, which
// then times out and marks the container unhealthy while it is actually
// indexing.
const EVENT_BATCH_BUDGET_MS = 8;

/**
 * Run relay events in short batches, yielding between batches.
 *
 * Order is preserved per relay. A handler that throws is reported through
 * `onError` and does not stop the remaining events, matching the previous
 * inline behaviour.
 *
 * @param {(event: object) => void} handler
 * @param {(error: unknown) => void} onError
 * @param {number} [budgetMs]
 */
export function createEventBatch(handler, onError, budgetMs = EVENT_BATCH_BUDGET_MS) {
  const queue = [];
  let head = 0;
  let draining = false;

  function drain() {
    const started = Date.now();
    while (head < queue.length && Date.now() - started < budgetMs) {
      const event = queue[head++];
      try {
        handler(event);
      } catch (error) {
        onError(error);
      }
    }
    if (head < queue.length) {
      setImmediate(drain);
      return;
    }
    queue.length = 0;
    head = 0;
    draining = false;
  }

  return (event) => {
    queue.push(event);
    if (draining) return;
    draining = true;
    setImmediate(drain);
  };
}

/** Keeps one relay subscription alive and resumes its bounded backfill after disconnects. */
export function subscribeRelayWithBackoff(pool, relay, source, filter, onEvent, { store, monitor, since: initialSince } = {}) {
  let stopped = false;
  let timer = null;
  let subscription = null;
  let failures = 0;
  // One queue per subscription (not per connect), so a reconnect cannot
  // reorder events that are still waiting to be processed.
  const enqueueEvent = createEventBatch(onEvent, (error) => {
    monitor?.processingFailed(source);
    console.error(`[ncc-search] ${source} event handler failed:`, error);
  });

  function connect() {
    if (stopped) return;
    monitor?.connecting(source, relay);
    const cursor = store?.getDiscoveryCursor(source, relay) ?? initialSince ?? 0;
    const since = cursor ? Math.max(0, cursor - CHECKPOINT_OVERLAP_SECONDS) : undefined;
    const resumedFilter = since ? { ...filter, since } : filter;
    try {
      subscription = pool.subscribeMany([relay], resumedFilter, {
        onevent(event) {
          monitor?.event(source, relay);
          enqueueEvent(event);
        },
        oneose() {
          failures = 0;
          monitor?.eose(source, relay);
          try {
            store?.saveDiscoveryCursor(source, relay, Math.floor(Date.now() / 1000));
          } catch {
            monitor?.processingFailed(source);
            console.warn(`[ncc-search] ${source} checkpoint could not be saved`);
          }
        },
        onclose(reasons) {
          if (stopped) return;
          subscription = null;
          failures += 1;
          monitor?.failed(source, relay, reasons);
          const base = Math.min(INITIAL_BACKOFF_MS * (2 ** Math.min(failures - 1, 9)), MAX_BACKOFF_MS);
          const delay = Math.round(base * (0.8 + Math.random() * 0.4));
          timer = setTimeout(connect, delay);
        },
      });
    } catch (error) {
      if (stopped) return;
      failures += 1;
      monitor?.failed(source, relay, error);
      const base = Math.min(INITIAL_BACKOFF_MS * (2 ** Math.min(failures - 1, 9)), MAX_BACKOFF_MS);
      timer = setTimeout(connect, Math.round(base * (0.8 + Math.random() * 0.4)));
      console.warn(`[ncc-search] ${source} relay subscription failed; retry scheduled`);
    }
  }

  connect();
  return {
    close() {
      stopped = true;
      if (timer) clearTimeout(timer);
      const current = subscription;
      subscription = null;
      current?.close();
    },
  };
}

export function discoverFromRelays(pool, relays, source, filter, onEvent, options = {}) {
  const { relayRegistry, ...subscriptionOptions } = options;
  const subscriptions = new Map();
  function addRelay(relay) {
    if (subscriptions.has(relay)) return;
    subscriptions.set(relay, subscribeRelayWithBackoff(
      pool, relay, source, filter, onEvent, subscriptionOptions,
    ));
  }
  function removeRelay(relay) {
    subscriptions.get(relay)?.close();
    subscriptions.delete(relay);
  }
  addRelay.remove = removeRelay;
  for (const relay of relays) addRelay(relay);
  const unregister = relayRegistry?.register(addRelay);
  return {
    close() {
      unregister?.();
      for (const subscription of subscriptions.values()) subscription.close();
      subscriptions.clear();
    },
  };
}

/** Fans newly promoted relays out to every active discovery subscription. */
export function createRelayRegistry(initialRelays = []) {
  const relays = new Set(initialRelays);
  const usedRelays = new Set(initialRelays);
  const subscribers = new Set();
  return {
    add(relay) {
      if (relays.has(relay)) return false;
      relays.add(relay);
      usedRelays.add(relay);
      for (const subscribe of subscribers) subscribe(relay);
      return true;
    },
    remove(relay) {
      if (!relays.delete(relay)) return false;
      for (const subscribe of subscribers) subscribe.remove?.(relay);
      return true;
    },
    register(subscribe) {
      subscribers.add(subscribe);
      for (const relay of relays) subscribe(relay);
      return () => subscribers.delete(subscribe);
    },
    all() { return [...relays]; },
    allKnown() { return [...usedRelays]; },
  };
}
