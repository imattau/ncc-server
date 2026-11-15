// NIP-50 ("search" filter field) live-search adapter, for whichever
// configured relays advertise support in their NIP-11 document.
//
// Deliberately thin, for a reason confirmed while researching this project
// (see README): NIP-50 relay support is optional and inconsistent -- it's
// common for zero of a given relay list to support it. So this adapter
// never becomes a replacement discovery or trust path. A match it finds is
// fed straight into the owning crawler's ingest path, the exact same entry
// point the ambient relay subscription uses, so it still goes through full
// resolve/fetch/verify (NCC's `k` pin, nsite's sha256 check) before being
// trusted. What this adapter actually buys:
//   1. faster time-to-discovery for a specific query, instead of waiting
//      for the broad subscription to happen to see the same event, and
//   2. an immediate, clearly-marked "live, unverified" hit for responsiveness
//      (see server.js), never presented as equivalent to a verified result.

import { Nip11Prober } from '../nip11.js';
import { SERVICE_RECORD_KIND } from '../discovery.js';
import { KIND_ROOT_SITE, KIND_NAMED_SITE } from './nsite.js';
import { KIND_ARTICLE_EVENT } from './article.js';
import { MEDIA_KINDS, KIND_PICTURE } from './media.js';
import { stripMarkdown } from './markdown.js';

const SEARCHABLE_KINDS = [
  SERVICE_RECORD_KIND,
  KIND_ROOT_SITE,
  KIND_NAMED_SITE,
  KIND_ARTICLE_EVENT,
  ...MEDIA_KINDS,
];

export class Nip50Adapter {
  /**
   * @param {import('nostr-tools').SimplePool} pool
   * @param {import('../config.js').config} config
   * @param {{
   *   nccCrawler?: { ingestEvent(event: object): void },
   *   nsiteCrawler?: { ingestEvent(event: object): void },
   *   contentCrawler?: { ingestArticle(event: object): void, ingestMedia(event: object): void },
   * }} [crawlers]
   *   Verified crawlers to hand matches to. Omit any to run this adapter in
   *   a read-only/test mode where hits are returned but not ingested.
   */
  constructor(pool, config, crawlers = {}) {
    this.pool = pool;
    this.config = config;
    this.prober = new Nip11Prober({ timeoutMs: config.fetchTimeoutMs });
    this.nccCrawler = crawlers.nccCrawler ?? null;
    this.nsiteCrawler = crawlers.nsiteCrawler ?? null;
    this.contentCrawler = crawlers.contentCrawler ?? null;
  }

  /** @returns {Promise<string[]>} the subset of config.relays that advertise NIP-50 */
  async capableRelays() {
    return this.prober.filterCapable(this.config.relays);
  }

  /**
   * @param {string} query
   * @param {{ limit?: number, timeoutMs?: number }} [options]
   * @returns {Promise<LiveHit[]>}
   */
  async search(query, options = {}) {
    const relays = await this.capableRelays();
    if (!relays.length) return [];

    const limit = options.limit ?? 20;
    const filter = { search: query, kinds: SEARCHABLE_KINDS, limit };
    const timeoutMs = options.timeoutMs ?? this.config.fetchTimeoutMs;

    // SimplePool.querySync has no built-in timeout -- it waits for every
    // relay to close its subscription (eose or error), which a slow or
    // unresponsive relay could stall indefinitely. Same manual race pattern
    // NCC05Resolver uses for the same reason.
    let events;
    try {
      events = await Promise.race([
        this.pool.querySync(relays, filter),
        new Promise((resolve) => setTimeout(() => resolve([]), timeoutMs)),
      ]);
    } catch {
      events = [];
    }

    const hits = [];
    for (const event of events) {
      if (!SEARCHABLE_KINDS.includes(event.kind)) continue; // a lenient relay could ignore `kinds`
      this.ingest(event);
      const hit = toLiveHit(event);
      if (hit) hits.push(hit);
    }
    return hits;
  }

  ingest(event) {
    if (event.kind === SERVICE_RECORD_KIND) {
      this.nccCrawler?.ingestEvent(event);
    } else if (event.kind === KIND_ROOT_SITE || event.kind === KIND_NAMED_SITE) {
      this.nsiteCrawler?.ingestEvent(event);
    } else if (event.kind === KIND_ARTICLE_EVENT) {
      this.contentCrawler?.ingestArticle(event);
    } else if (MEDIA_KINDS.includes(event.kind)) {
      this.contentCrawler?.ingestMedia(event);
    }
  }
}

function toLiveHit(event) {
  const dTag = event.tags.find((t) => t[0] === 'd')?.[1] ?? null;
  const title = event.tags.find((t) => t[0] === 'title')?.[1] ?? null;
  const summaryOrDescription =
    event.tags.find((t) => t[0] === 'summary')?.[1] ??
    event.tags.find((t) => t[0] === 'description')?.[1] ??
    null;
  // An article with neither tag falls back to its raw NIP-23 `content` --
  // unlike a crawled article (resolveArticle() in article.js, via
  // upsertContent), that fallback never went through stripMarkdown(), so a
  // live-only hit could surface raw Markdown (headings, link syntax,
  // un-stripped `nostr:` references) straight into a search result's
  // snippet line. Same cleanup a properly indexed article already gets,
  // not a second one -- and a no-op for every other kind, which never
  // falls back to raw content here in the first place.
  const fallbackDescription =
    event.kind === KIND_ARTICLE_EVENT ? stripMarkdown(event.content) : event.content;

  let kind;
  let itemId;
  if (event.kind === SERVICE_RECORD_KIND) {
    kind = 'ncc-service';
    itemId = dTag;
  } else if (event.kind === KIND_ROOT_SITE) {
    kind = 'nsite-root';
    itemId = '_root';
  } else if (event.kind === KIND_NAMED_SITE) {
    kind = 'nsite-named';
    itemId = dTag;
  } else if (event.kind === KIND_ARTICLE_EVENT) {
    kind = 'article';
    itemId = dTag;
  } else if (MEDIA_KINDS.includes(event.kind)) {
    kind = event.kind === KIND_PICTURE ? 'image' : 'video';
    itemId = dTag ?? event.id; // regular (non-addressable) media kinds have no `d`
  } else {
    return null;
  }

  // An addressable item with no `d` tag has no stable identity to key a
  // result on; same stance discovery.js/article.js/media.js already take.
  if (itemId == null) return null;

  return {
    pubkey: event.pubkey,
    kind,
    itemId,
    title,
    description: summaryOrDescription ?? fallbackDescription ?? null,
    eventId: event.id,
    source: 'live', // never conflate with a verified, crawled result -- see server.js
  };
}

/**
 * @typedef {Object} LiveHit
 * @property {string} pubkey
 * @property {'ncc-service'|'nsite-root'|'nsite-named'|'article'|'image'|'video'} kind
 * @property {string} itemId
 * @property {string|null} title
 * @property {string|null} description
 * @property {string} eventId
 * @property {'live'} source
 */
