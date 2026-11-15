const SOURCES = ['ncc-services', 'nsites', 'articles', 'media'];

/** In-memory relay health summary. Relay URLs and error text never leave this process. */
export function createCrawlMonitor() {
  const sources = new Map(SOURCES.map((source) => [source, new Map()]));
  const processingFailures = new Map(SOURCES.map((source) => [source, 0]));

  function relay(source, url) {
    const entries = sources.get(source);
    if (!entries) return null;
    if (!entries.has(url)) {
      entries.set(url, {
        connected: null,
        connecting: false,
        lastEventAt: null,
        lastEoseAt: null,
        lastFailureAt: null,
        consecutiveFailures: 0,
        failureCount: 0,
      });
    }
    return entries.get(url);
  }

  return {
    connecting(source, url) {
      const state = relay(source, url);
      if (state) state.connecting = true;
    },
    event(source, url) {
      const state = relay(source, url);
      if (state) {
        state.connected = true;
        state.connecting = false;
        state.lastEventAt = Date.now();
        state.consecutiveFailures = 0;
      }
    },
    eose(source, url) {
      const state = relay(source, url);
      if (state) {
        state.connected = true;
        state.connecting = false;
        state.lastEoseAt = Date.now();
        state.consecutiveFailures = 0;
      }
    },
    failed(source, url) {
      const state = relay(source, url);
      if (state) {
        state.connected = false;
        state.connecting = false;
        state.lastFailureAt = Date.now();
        state.consecutiveFailures += 1;
        state.failureCount += 1;
      }
    },
    processingFailed(source) {
      if (processingFailures.has(source)) processingFailures.set(source, processingFailures.get(source) + 1);
    },
    snapshot() {
      const result = {};
      for (const [source, entries] of sources) {
        const states = [...entries.values()];
        const lastEventAt = states.reduce((latest, state) => Math.max(latest, state.lastEventAt ?? 0), 0);
        const lastEoseAt = states.reduce((latest, state) => Math.max(latest, state.lastEoseAt ?? 0), 0);
        const failedRelays = states.filter((state) => state.connected === false).length;
        const connectedRelays = states.filter((state) => state.connected === true).length;
        const connectingRelays = states.filter((state) => state.connecting).length;
        result[source] = {
          relayCount: states.length,
          connectedRelays,
          connectingRelays,
          failedRelays,
          failureCount: states.reduce((total, state) => total + state.failureCount, 0),
          processingFailureCount: processingFailures.get(source),
          lastEventAt: lastEventAt || null,
          lastSuccessfulSyncAt: lastEoseAt || null,
          lastFailureAt: states.reduce((latest, state) => Math.max(latest, state.lastFailureAt ?? 0), 0) || null,
          state: states.length === 0 || connectingRelays > 0 || connectedRelays + failedRelays < states.length
            ? 'starting'
            : failedRelays === 0
              ? 'healthy'
              : failedRelays === states.length
                ? 'unavailable'
                : 'degraded',
        };
      }
      return result;
    },
  };
}
