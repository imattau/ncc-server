const CHECKPOINT_OVERLAP_SECONDS = 5 * 60;
const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 5 * 60_000;

/** Keeps one relay subscription alive and resumes its bounded backfill after disconnects. */
export function subscribeRelayWithBackoff(pool, relay, source, filter, onEvent, { store, monitor, since: initialSince } = {}) {
  let stopped = false;
  let timer = null;
  let subscription = null;
  let failures = 0;

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
          try {
            onEvent(event);
          } catch (error) {
            monitor?.processingFailed(source);
            console.error(`[ncc-search] ${source} event handler failed:`, error);
          }
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
