import { useNostr } from '@nostrify/react';
import { useQuery } from '@tanstack/react-query';

const KIND_CONTACTS = 3; // NIP-02

/** The logged-in NIP-07 pubkey's follow list, for ranking.ts's follow-boost. */
export function useFollows(pubkey: string | null) {
  const { nostr } = useNostr();

  return useQuery<Set<string>>({
    queryKey: ['nostr', 'follows', pubkey ?? ''],
    queryFn: async () => {
      if (!pubkey) return new Set<string>();
      const [event] = await nostr.query([{ kinds: [KIND_CONTACTS], authors: [pubkey], limit: 1 }], {
        signal: AbortSignal.timeout(4000),
      });
      if (!event) return new Set<string>();
      return new Set(event.tags.filter((t) => t[0] === 'p' && t[1]).map((t) => t[1]));
    },
    enabled: !!pubkey,
    staleTime: 10 * 60 * 1000,
    retry: 1,
  });
}
