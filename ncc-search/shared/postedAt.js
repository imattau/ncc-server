// When the event behind a row was posted, in unix seconds -- the date the
// search UI shows and sorts by.
//
// NIP-23 articles carry `published_at`: the date the author calls the posting
// date, which does not move when the article is edited and republished (the
// event's own `created_at` does). Everything else uses `created_at`, which is
// the only timestamp the event has.
//
// This lives in `shared/` because two independent writers compute it: the
// Node crawler (src/) and the nsite edition's in-browser crawler
// (ui/src/lib/local/). They run in different runtimes and never share a
// database, but if they disagreed a row's date would change depending on
// which one indexed it. It is also the same rule src/backfillPostedAt.js
// relies on, which is why that script imports this through src/postedAt.js
// rather than inlining it.
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
