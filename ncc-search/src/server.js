// Minimal HTTP API. Same framework (Fastify) as the ncc-sidecar admin UI, so
// this process fits the rest of the stack rather than introducing a second
// web framework. Intended to sit behind Caddy on a separate path/port, same
// pattern as every other service in this repo.

import Fastify from 'fastify';
import cors from '@fastify/cors';

/**
 * @param {ReturnType<typeof import('./store.js').openStore>} store
 * @param {import('./adapters/nip50.js').Nip50Adapter} [nip50Adapter] optional
 *   -- omit to run index-only, e.g. in tests or with NIP-50 disabled.
 * @param {{ corsOrigin?: string | boolean, crawlMonitor?: { snapshot: () => object } }} [options]
 *   `corsOrigin` defaults to `true` (reflect any request origin). This is a
 *   public, read-only, unauthenticated search API -- no cookies, no
 *   credentials -- so a permissive default is the same risk profile as a
 *   regular web search engine's API, not an open CORS misconfiguration on
 *   something that carries auth. Without CORS enabled at all, the `ui/`
 *   frontend (served from its own origin/port in dev, and often its own
 *   subdomain behind Caddy in production -- see ui/README.md) cannot call
 *   this endpoint from the browser; this was caught live while standing up
 *   the UI for the first time (`fetch` failing with no CORS headers set).
 */
export function createServer(store, nip50Adapter = null, options = {}) {
  const app = Fastify({ logger: false });
  app.register(cors, { origin: options.corsOrigin ?? true });

  app.get('/health', async () => ({ ok: true }));

  app.get('/status', async () => ({
    ok: true,
    checkedAt: Date.now(),
    index: store.getStatus?.() ?? null,
    crawlers: options.crawlMonitor?.snapshot?.() ?? {},
  }));

  app.get('/search', async (req, reply) => {
    const q = (req.query.q || '').trim();
    if (!q) return reply.code(400).send({ error: 'missing q' });
    const limit = Math.min(Number(req.query.limit) || 20, 100);
    const offset = Math.max(Number(req.query.offset) || 0, 0);

    // Fetch one extra row to know whether another page exists, without a
    // separate COUNT(*) query -- then trim it back off before returning.
    const indexRows = store.search(q, limit + 1, offset);
    const hasMore = indexRows.length > limit;
    const indexResults = indexRows.slice(0, limit).map((r) => ({ ...r, source: 'index' }));

    // Live NIP-50 results supplement the verified index; they never
    // replace it, and are only shown for a pubkey/item not already in it --
    // the index result is the one that passed resolve/fetch/verify, so it
    // always wins when both exist. Only fetched on the first page: a live
    // relay search has no stable offset/cursor of its own, so paging it
    // would either repeat the same hits on every page or silently drop
    // some -- the index (which does support offset) carries pagination
    // from page 2 on.
    let liveHits = [];
    if (nip50Adapter && req.query.live !== 'false' && offset === 0) {
      const seen = new Set(indexResults.map((r) => `${r.pubkey}\u0000${r.itemId}`));
      const found = await nip50Adapter.search(q, { limit });
      // Dedupe against each other too, not just against the index: two
      // relays can each serve a different event id for the same
      // (pubkey, itemId) coordinate (e.g. after the author republished an
      // addressable record and relays disagree on which copy they have),
      // and querySync's own id-based dedup (nostr-tools) wouldn't catch
      // that since the ids genuinely differ. First one seen wins.
      for (const hit of found) {
        const key = `${hit.pubkey}\u0000${hit.itemId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        liveHits.push(hit);
      }
    }

    return { query: q, results: [...indexResults, ...liveHits], hasMore };
  });

  // :itemId is an NCC-02 `d` tag, an nsite `d` tag, or `_root` for a root site.
  app.get('/services/:pubkey/:itemId', async (req, reply) => {
    const item = store.getService(req.params.pubkey, req.params.itemId);
    if (!item) return reply.code(404).send({ error: 'not found' });
    return item;
  });

  return app;
}
