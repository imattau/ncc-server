import { type NostrEvent } from '@nostrify/nostrify';
import { useNostr } from '@nostrify/react';
import { useQuery } from '@tanstack/react-query';

export const KIND_ARTICLE = 30023;

// The backend indexes an article's title/summary/cover and a stripped,
// snippet-sized excerpt of its body -- enough to rank and label a result, but
// not enough to render one. So the full article comes from the relays, in the
// browser, the same way useAuthor resolves a display name: this page has no
// account, no signer and no publish path, so the pool only ever reads.
//
// `enabled: false` until the reader asks for a preview (see
// ArticlePreviewDialog): opening a results page must not fire one relay query
// per article row, and the dialog can sit closed in the tree without costing
// anything.
export function useArticleEvent(pubkey: string, itemId: string, enabled: boolean) {
  const { nostr } = useNostr();

  return useQuery<NostrEvent>({
    queryKey: ['nostr', 'article', pubkey, itemId],
    queryFn: async () => {
      // Addressable (kind:30023 + `d`), so this is an exact coordinate
      // lookup, not a "search the author's posts and hope" scan. `limit` is
      // above 1 because relays can disagree about which copy of a replaced
      // addressable event they still hold.
      const events = await nostr.query(
        [{ kinds: [KIND_ARTICLE], authors: [pubkey], '#d': [itemId], limit: 5 }],
        { signal: AbortSignal.timeout(8000) },
      );

      // Filter locally as well: a relay that ignores the `#d` filter (or a
      // stale copy under another `d`) must not get to stand in for this one.
      const event = events.find(
        (candidate) =>
          candidate.kind === KIND_ARTICLE &&
          candidate.pubkey === pubkey &&
          candidate.tags.some((tag) => tag[0] === 'd' && tag[1] === itemId),
      );

      if (!event) {
        throw new Error('The configured relays did not return this article.');
      }
      return event;
    },
    enabled,
    // A published article is immutable until the author replaces the same
    // `d` -- five minutes just keeps reopening the dialog from re-querying
    // every relay while reading.
    staleTime: 5 * 60 * 1000,
    retry: 1,
  });
}
