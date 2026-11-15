import { useNostr } from '@nostrify/react';
import { useQuery } from '@tanstack/react-query';

const KIND_INTERESTS = 10015; // NIP-51, standard (non-addressable) interest list
const KIND_NOTE = 1;
const RECENT_NOTES_SAMPLE = 100;
const MAX_INFERRED_INTERESTS = 15;

/**
 * The logged-in NIP-07 pubkey's interests, for ranking.ts's hashtag-boost.
 * Two sources, unioned:
 *   - kind:10015, the explicit NIP-51 interest list, if the user has one
 *     (not all that common in practice today)
 *   - the most-used hashtags across the user's own recent notes (kind:1),
 *     as a fallback heuristic that's actually populated for most accounts
 *
 * Does NOT follow kind:10015's `a` tags to referenced kind:30015 named
 * interest sets -- that's a real NIP-51 feature this skips for now, each
 * reference being its own relay round-trip for a signal most users won't
 * have populated anyway.
 */
export function useInterests(pubkey: string | null) {
  const { nostr } = useNostr();

  return useQuery<Set<string>>({
    queryKey: ['nostr', 'interests', pubkey ?? ''],
    queryFn: async () => {
      if (!pubkey) return new Set<string>();

      const [interestListEvents, notes] = await Promise.all([
        nostr.query([{ kinds: [KIND_INTERESTS], authors: [pubkey], limit: 1 }], {
          signal: AbortSignal.timeout(4000),
        }),
        nostr.query([{ kinds: [KIND_NOTE], authors: [pubkey], limit: RECENT_NOTES_SAMPLE }], {
          signal: AbortSignal.timeout(4000),
        }),
      ]);

      const interests = new Set<string>();
      for (const tag of interestListEvents[0]?.tags ?? []) {
        if (tag[0] === 't' && tag[1]) interests.add(tag[1].toLowerCase());
      }

      const frequency = new Map<string, number>();
      for (const note of notes) {
        for (const tag of note.tags) {
          if (tag[0] !== 't' || !tag[1]) continue;
          const hashtag = tag[1].toLowerCase();
          frequency.set(hashtag, (frequency.get(hashtag) ?? 0) + 1);
        }
      }
      const topInferred = [...frequency.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, MAX_INFERRED_INTERESTS)
        .map(([hashtag]) => hashtag);
      for (const hashtag of topInferred) interests.add(hashtag);

      return interests;
    },
    enabled: !!pubkey,
    staleTime: 10 * 60 * 1000,
    retry: 1,
  });
}
