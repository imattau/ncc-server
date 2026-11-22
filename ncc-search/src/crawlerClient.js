// Client for the crawler process's private HTTP surface (see internal.js).
//
// Only src/api.js uses this. Both calls are best-effort by design:
//
//   - status()  short timeout; /status reports `crawlersUnavailable` rather
//               than failing when the crawler is restarting.
//   - ingest()  fire-and-forget, never awaited by a request handler: a live
//               NIP-50 hit only needs to *reach* the crawler eventually, and
//               a slow crawler must never slow down /search.

const DEFAULT_TIMEOUT_MS = 1000;

/**
 * @param {{ baseUrl: string, timeoutMs?: number }} options
 */
export function createCrawlerClient({ baseUrl, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const base = baseUrl.replace(/\/+$/, '');

  async function status() {
    try {
      const res = await fetch(`${base}/internal/status`, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) return null;
      return await res.json();
    } catch {
      // Crawler restarting / not up yet / timed out: the API still serves the
      // index, it just cannot report crawl health this request.
      return null;
    }
  }

  /**
   * @param {object} event raw Nostr event
   * @returns {Promise<boolean>} whether the crawler accepted it -- callers do
   *   not await this on the request path, it exists for tests and diagnostics
   */
  async function ingest(event) {
    try {
      const res = await fetch(`${base}/internal/ingest`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ event }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  return { status, ingest };
}

/**
 * The shape Nip50Adapter expects from its `crawlers` argument (see
 * adapters/nip50.js): one method per adapter ingest entry point, all posting
 * to the same endpoint -- the crawler repeats the kind-based routing on the
 * other side (see ingest.js), so the API does not need to know which adapter
 * owns which kind.
 *
 * One thing the hop loses: the crawler's own pool never saw the event, so
 * `takeSeenRelays()` (relayTracking.js) yields nothing for a row indexed this
 * way. That is only the per-row "how many relays carry this" signal, and it
 * self-heals -- upserts COALESCE `seen_relays`, so the ambient crawl fills it
 * in when it next sees the same event.
 *
 * @param {ReturnType<typeof createCrawlerClient>} client
 */
export function createIngestForwarder(client) {
  const forward = (event) => {
    // Not awaited on purpose; a rejected promise here would be an unhandled
    // rejection in an event callback, and ingest() never rejects.
    client.ingest(event);
  };
  return {
    nccCrawler: { ingestEvent: forward },
    nsiteCrawler: { ingestEvent: forward },
    contentCrawler: {
      ingestArticle: forward,
      ingestMedia: forward,
      ingestEvent: forward,
      ingestLiveStream: forward,
      ingestApp: forward,
      ingestCommunity: forward,
    },
  };
}
