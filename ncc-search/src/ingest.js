// Routing for raw relay events that arrive outside a crawl subscription's
// own delivery -- today that means NIP-50 live-search hits.
//
// NIP-50 hits are handed to the same ingest entry point each adapter's
// ambient subscription uses, so they still go through the full
// resolve/fetch/verify pipeline (NCC's `k` pin, nsite's sha256 check) before
// being trusted; nothing here writes a row directly.
//
// Shared because the API and the crawler are separate processes (see
// README.md "Two processes"): the API does the live relay query -- it is a
// read-only operation -- and posts whatever it finds to the crawler's
// POST /internal/ingest, which routes it here. Same function both sides, so
// there is no second, drifting copy of the kind-to-adapter mapping.

import { SERVICE_RECORD_KIND } from './discovery.js';
import { KIND_ROOT_SITE, KIND_NAMED_SITE } from './adapters/nsite.js';
import { KIND_ARTICLE_EVENT } from './adapters/article.js';
import { MEDIA_KINDS } from './adapters/media.js';
import { CALENDAR_KINDS } from './adapters/calendar.js';
import { LIVE_STREAM_KINDS } from './adapters/live.js';

/**
 * @param {{ nccCrawler?: { ingestEvent(event: object): void }|null,
 *           nsiteCrawler?: { ingestEvent(event: object): void }|null,
 *           contentCrawler?: { ingestArticle(event: object): void, ingestMedia(event: object): void, ingestEvent(event: object): void, ingestLiveStream(event: object): void }|null }} crawlers
 *   Omit any to leave that kind unrouted (the crawler for it is disabled).
 * @param {object} event a raw Nostr event (kind/pubkey/tags/content)
 * @returns {boolean} true if an adapter accepted the event
 */
export function routeEventToCrawlers(crawlers, event) {
  if (!event || typeof event.kind !== 'number') return false;
  if (event.kind === SERVICE_RECORD_KIND) {
    if (!crawlers.nccCrawler) return false;
    crawlers.nccCrawler.ingestEvent(event);
    return true;
  }
  if (event.kind === KIND_ROOT_SITE || event.kind === KIND_NAMED_SITE) {
    if (!crawlers.nsiteCrawler) return false;
    crawlers.nsiteCrawler.ingestEvent(event);
    return true;
  }
  if (event.kind === KIND_ARTICLE_EVENT) {
    if (!crawlers.contentCrawler) return false;
    crawlers.contentCrawler.ingestArticle(event);
    return true;
  }
  if (MEDIA_KINDS.includes(event.kind)) {
    if (!crawlers.contentCrawler?.ingestMedia) return false;
    crawlers.contentCrawler.ingestMedia(event);
    return true;
  }
  if (CALENDAR_KINDS.includes(event.kind)) {
    if (!crawlers.contentCrawler?.ingestEvent) return false;
    crawlers.contentCrawler.ingestEvent(event);
    return true;
  }
  if (LIVE_STREAM_KINDS.includes(event.kind)) {
    if (!crawlers.contentCrawler?.ingestLiveStream) return false;
    crawlers.contentCrawler.ingestLiveStream(event);
    return true;
  }
  return false;
}
