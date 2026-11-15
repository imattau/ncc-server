import { type NostrEvent, type NostrMetadata, NSchema as n } from '@nostrify/nostrify';
import { useNostr } from '@nostrify/react';
import { useQuery } from '@tanstack/react-query';

// Same shape as test-app/src/hooks/useAuthor.ts: a kind:0 lookup, used here
// only so a result can show a display name instead of a bare npub -- never
// for trust. A verified nip05, if the backend attached one, is a stronger
// signal than this and takes priority wherever both are shown together.
export function useAuthor(pubkey: string | undefined) {
  const { nostr } = useNostr();

  return useQuery<{ event?: NostrEvent; metadata?: NostrMetadata }>({
    queryKey: ['nostr', 'author', pubkey ?? ''],
    queryFn: async () => {
      if (!pubkey) {
        return {};
      }

      const [event] = await nostr.query([{ kinds: [0], authors: [pubkey], limit: 1 }], {
        signal: AbortSignal.timeout(1500),
      });

      if (!event) {
        throw new Error('No event found');
      }

      try {
        const metadata = n.json().pipe(n.metadata()).parse(event.content);
        return { metadata, event };
      } catch {
        return { event };
      }
    },
    staleTime: 5 * 60 * 1000,
    retry: 1,
  });
}
