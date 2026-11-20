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
import { routeEventToCrawlers } from '../ingest.js';
import { KIND_ROOT_SITE, KIND_NAMED_SITE } from './nsite.js';
import { KIND_ARTICLE_EVENT } from './article.js';
import { MEDIA_KINDS, resolveMedia, storeKindFor } from './media.js';
import { CALENDAR_KINDS } from './calendar.js';
import { LIVE_STREAM_KINDS } from './live.js';
import { stripMarkdown } from './markdown.js';

const SEARCHABLE_KINDS = [
  SERVICE_RECORD_KIND,
  KIND_ROOT_SITE,
  KIND_NAMED_SITE,
  KIND_ARTICLE_EVENT,
  ...MEDIA_KINDS,
  ...CALENDAR_KINDS,
  ...LIVE_STREAM_KINDS,
];

// Client-supplied relays (NIP-65 fan-out) get a short probe: a search request
// should not wait the full configured timeout on a relay the caller just
// nominated, and negative results are cached like any other.
const CLIENT_RELAY_PROBE_TIMEOUT_MS = 3000;

export class Nip50Adapter {
  /**
   * @param {import('nostr-tools').SimplePool} pool
   * @param {import('../config.js').config} config
   * @param {{
   *   nccCrawler?: { ingestEvent(event: object): void },
   *   nsiteCrawler?: { ingestEvent(event: object): void },
   *   contentCrawler?: { ingestArticle(event: object): void, ingestMedia(event: object): void,
   *                      ingestEvent(event: object): void, ingestLiveStream(event: object): void },
   * }} [crawlers]
   *   Where to hand matches for full resolve/fetch/verify (see ingest.js).
   *   Omit any to run this adapter in a read-only/test mode where hits are
   *   returned but not ingested. In src/api.js these are not the crawlers
   *   themselves but forwarders that POST to the crawler process -- the API
   *   holds no crawl state, and the routing this file applies is identical
   *   either way.
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
   * @param {{ limit?: number, timeoutMs?: number, extraRelays?: string[] }} [options]
   *   `extraRelays` are the caller's own NIP-65 relays. They are queried for
   *   live hits but never ingested: the node's index only grows from relays
   *   its operator configured. Invalid/duplicate entries are ignored here;
   *   server.js validates them first.
   * @returns {Promise<LiveHit[]>}
   */
  async search(query, options = {}) {
    const limit = options.limit ?? 20;
    const timeoutMs = options.timeoutMs ?? this.config.fetchTimeoutMs;
    const normalizeRelay = (relay) => {
      try {
        return new URL(relay).href;
      } catch {
        return relay;
      }
    };
    const configuredUrls = new Set(this.config.relays.map(normalizeRelay));
    const extraRelays = [...new Set((options.extraRelays ?? []).map(normalizeRelay))]
      .filter((relay) => !configuredUrls.has(relay));

    const [configured, extra] = await Promise.all([
      this.capableRelays(),
      extraRelays.length
        ? this.prober.filterCapable(extraRelays, { timeoutMs: CLIENT_RELAY_PROBE_TIMEOUT_MS })
        : Promise.resolve([]),
    ]);
    if (!configured.length && !extra.length) return [];

    const filter = { search: query, kinds: SEARCHABLE_KINDS, limit };

    // SimplePool.querySync has no built-in timeout -- it waits for every
    // relay to close its subscription (eose or error), which a slow or
    // unresponsive relay could stall indefinitely. Same manual race pattern
    // NCC05Resolver uses for the same reason. The two sets are queried
    // separately because only the configured relays' events go through the
    // ingest path.
    const [configuredEvents, extraEvents] = await Promise.all([
      this.queryRelays(configured, filter, timeoutMs),
      this.queryRelays(extra, filter, timeoutMs),
    ]);

    const hits = [];
    const seen = new Set();
    const add = (event, ingest) => {
      if (!SEARCHABLE_KINDS.includes(event.kind)) return; // a lenient relay could ignore `kinds`
      const hit = toLiveHit(event);
      if (!hit) return;
      const key = `${hit.pubkey}\u0000${hit.itemId}`;
      if (seen.has(key)) return;
      seen.add(key);
      if (ingest) this.ingest(event);
      hits.push(hit);
    };
    for (const event of configuredEvents) add(event, true);
    for (const event of extraEvents) add(event, false);
    return hits.slice(0, limit);
  }

  async queryRelays(relays, filter, timeoutMs) {
    if (!relays.length) return [];
    try {
      return await Promise.race([
        this.pool.querySync(relays, filter),
        new Promise((resolve) => setTimeout(() => resolve([]), timeoutMs)),
      ]);
    } catch {
      return [];
    }
  }

  ingest(event) {
    // Same kind-to-adapter routing the crawler's internal ingest endpoint
    // uses (see ingest.js) -- in this process the "crawlers" are either the
    // real ones (embedded mode) or a forwarder that posts to the crawler.
    routeEventToCrawlers(this, event);
  }
}

function toLiveHit(event) {
  const dTag = event.tags.find((t) => t[0] === 'd')?.[1] ?? null;
  const title = event.tags.find((t) => t[0] === 'title')?.[1] ?? null;
  const summaryOrDescription =
    event.tags.find((t) => t[0] === 'summary')?.[1] ??
    event.tags.find((t) => t[0] === 'description')?.[1] ??
    null;
  // An article, calendar event or live stream with no summary tag falls back
  // to its raw `content` -- unlike a crawled row (resolveArticle()/
  // resolveEvent()/resolveLiveStream(), via upsertContent), that fallback
  // never went through stripMarkdown(), so a live-only hit could surface raw
  // Markdown (headings, link syntax, un-stripped `nostr:` references) straight
  // into a search result's snippet line. Same cleanup a properly indexed row
  // already gets, not a second one -- and a no-op for every other kind, which
  // never falls back to raw content here in the first place.
  const markdownBody =
    event.kind === KIND_ARTICLE_EVENT
    || CALENDAR_KINDS.includes(event.kind)
    || LIVE_STREAM_KINDS.includes(event.kind);
  const fallbackDescription = markdownBody ? stripMarkdown(event.content) : event.content;

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
    kind = storeKindFor(event.kind);
    itemId = dTag ?? event.id; // regular (non-addressable) media kinds have no `d`
  } else if (CALENDAR_KINDS.includes(event.kind)) {
    kind = 'event';
    itemId = dTag;
  } else if (LIVE_STREAM_KINDS.includes(event.kind)) {
    kind = 'live-stream';
    itemId = dTag;
  } else {
    return null;
  }

  // An addressable item with no `d` tag has no stable identity to key a
  // result on; same stance discovery.js/article.js/media.js already take.
  if (itemId == null) return null;

  // A media hit must carry the same imeta fields a crawled row does, or the
  // UI has no media URL to launch and no poster to show: it renders an
  // anonymous empty tile. There is nothing to resolve or verify for media
  // (this backend never fetches the bytes), so the event's own imeta tags are
  // enough -- see resolveMedia().
  const media = MEDIA_KINDS.includes(event.kind) ? resolveMedia(event) : null;

  return {
    pubkey: event.pubkey,
    kind,
    itemId,
    title,
    description: summaryOrDescription ?? fallbackDescription ?? null,
    ...(media
      ? {
        mediaUrl: media.mediaUrl,
        mediaType: media.mediaType,
        thumbnailUrl: media.thumbnailUrl,
        blurhash: media.blurhash,
        thumbhash: media.thumbhash,
        contentWarning: media.contentWarning,
        hashtags: media.hashtags,
      }
      : {}),
    ...liveStructuredFields(event, kind),
    eventId: event.id,
    source: 'live', // never conflate with a verified, crawled result -- see server.js
  };
}

/** The fields a live hit can render without waiting for the crawler to index it. */
function liveStructuredFields(event, kind) {
  if (kind !== 'event' && kind !== 'live-stream') return {};
  const tag = (name) => event.tags.find((t) => t[0] === name)?.[1]?.trim() || null;
  const isDateOnly = event.kind === 31922;
  const seconds = (value) => {
    if (!value) return null;
    if (isDateOnly && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
      const ms = Date.parse(`${value}T00:00:00.000Z`);
      return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
    }
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
  };
  return {
    thumbnailUrl: tag('image'),
    startsAt: kind === 'event' ? seconds(tag('start')) : seconds(tag('starts')),
    endsAt: kind === 'event' ? seconds(tag('end')) : seconds(tag('ends')),
    allDay: kind === 'event' && isDateOnly ? 1 : 0,
    location: kind === 'event' ? tag('location') : null,
    liveStatus: kind === 'live-stream' ? tag('status') : null,
  };
}

/**
 * @typedef {Object} LiveHit
 * @property {string} pubkey
 * @property {'ncc-service'|'nsite-root'|'nsite-named'|'article'|'image'|'video'|'short-video'|'event'|'live-stream'} kind
 * @property {string} itemId
 * @property {string|null} title
 * @property {string|null} description
 * @property {string} [mediaUrl] - image/video: the imeta file URL, when present
 * @property {string|null} [mediaType]
 * @property {string|null} [thumbnailUrl]
 * @property {string|null} [blurhash]
 * @property {string|null} [thumbhash]
 * @property {string|null} [contentWarning]
 * @property {string[]|null} [hashtags]
 * @property {string} eventId
 * @property {'live'} source
 */
