// When the event behind a row was posted, in unix seconds -- the date the
// search UI shows and sorts by.
//
// NIP-23 articles carry `published_at`: the date the author calls the posting
// date, which does not move when the article is edited and republished (the
// event's own `created_at` does). Everything else uses `created_at`, which is
// the only timestamp the event has.
//
// One helper rather than inline logic in each adapter because the one-off
// backfill (src/backfillPostedAt.js) has to agree with the crawler exactly:
// if it computed a different date, re-running it would silently rewrite dates
// a crawl had already stored correctly.
const NIP23_ARTICLE_KIND = 30023;

/**
 * @param {{ kind?: number, created_at?: number, tags?: string[][] }} event
 * @returns {number|null} unix seconds, or null if the event has no usable time
 */
export function postedAtOf(event) {
  if (event.kind === NIP23_ARTICLE_KIND) {
    const published = Number(event.tags?.find((tag) => tag[0] === 'published_at')?.[1]);
    if (Number.isFinite(published) && published > 0) return published;
  }
  return Number.isFinite(event.created_at) && event.created_at > 0 ? event.created_at : null;
}
