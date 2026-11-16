const SOURCES = ['ncc-services', 'nsites', 'articles', 'media'];

const DEFAULT_STALE_MS = 6 * 60 * 60_000;
const MAX_ERROR_LENGTH = 200;
const MAX_REASON_KEYS = 20;

// Relay-supplied close reasons are untrusted text: strip control characters
// and bound the length before exposing them on /status.
function sanitizeError(error) {
  if (error == null) return null;
  const text = Array.isArray(error) ? error.join('; ') : String(error?.message ?? error);
  return text.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, MAX_ERROR_LENGTH) || null;
}

/**
 * In-memory relay health summary, exposed on /status.
 *
 * `state` is a diagnostic ('starting' | 'healthy' | 'degraded' | 'unavailable');
 * 'degraded' means at least one (but not every) relay is down. `incomplete`
 * is what clients should use to warn that results may be missing: true only
 * when no relay is connected, or no successful sync has happened within
 * `staleAfterMs` (NCC_SEARCH_CRAWL_STALE_MS).
 */
export function createCrawlMonitor({ staleAfterMs = DEFAULT_STALE_MS, now = Date.now } = {}) {
  const createdAt = now();
  const failureReasons = new Map(SOURCES.map((source) => [source, new Map()]));
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
        lastError: null,
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
    failed(source, url, error) {
      const state = relay(source, url);
      if (state) {
        state.lastError = sanitizeError(error) ?? state.lastError;
        state.connected = false;
        state.connecting = false;
        state.lastFailureAt = Date.now();
        state.consecutiveFailures += 1;
        state.failureCount += 1;
      }
    },
    processingFailed(source, reason) {
      if (!processingFailures.has(source)) return;
      processingFailures.set(source, processingFailures.get(source) + 1);
      if (reason) {
        const reasons = failureReasons.get(source);
        const key = String(reason).slice(0, 60);
        if (reasons.has(key) || reasons.size < MAX_REASON_KEYS) reasons.set(key, (reasons.get(key) ?? 0) + 1);
      }
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
        // A relay whose connection is currently up counts as synced right now:
        // EOSE is only sent once per (re)connect, so its timestamp ages while
        // the live subscription keeps delivering.
        const t = now();
        const lastSyncAt = connectedRelays > 0 ? t : (lastEoseAt || lastEventAt || null);
        const stale = t - (lastSyncAt ?? createdAt) > staleAfterMs;
        const state = states.length === 0 || connectingRelays > 0 || connectedRelays + failedRelays < states.length
          ? 'starting'
          : failedRelays === 0
            ? 'healthy'
            : failedRelays === states.length
              ? 'unavailable'
              : 'degraded';
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
          state,
          incomplete: state === 'unavailable' || stale,
          stale,
          processingFailureReasons: Object.fromEntries(failureReasons.get(source)),
          relays: [...entries.entries()].map(([url, r]) => ({
            url,
            connected: r.connected,
            connecting: r.connecting,
            failureCount: r.failureCount,
            consecutiveFailures: r.consecutiveFailures,
            lastError: r.lastError,
            lastFailureAt: r.lastFailureAt,
            lastEventAt: r.lastEventAt,
            lastEoseAt: r.lastEoseAt,
          })),
        };
      }
      return result;
    },
  };
}
