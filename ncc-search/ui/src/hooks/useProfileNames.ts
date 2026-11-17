import { type NostrEvent } from '@nostrify/nostrify';
import { useNostr } from '@nostrify/react';
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';

// Most relays cap the number of values in one filter, so a long article that
// mentions fifty people is fetched in a few batches rather than one filter
// some relays would truncate.
const AUTHORS_PER_QUERY = 40;
const LOOKUP_TIMEOUT_MS = 4_000;

function stringField(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * Display names for a set of pubkeys: the people a preview mentions and the
 * authors of the notes it quotes, so the reader sees "@alice" and not a
 * 63-character bech32 blob (or a hex key).
 *
 * Deliberately client-side, like the article fetch and the byline's author
 * lookup: the search backend is an index, and resolving a current kind:0 is
 * something the reader's own browser can do without that being proxied or
 * cached anywhere. Failure is not an error state -- the mention still renders,
 * just with a shortened npub -- so a slow or unreachable relay never costs the
 * reader the article text.
 */
export function useProfileNames(pubkeys: string[]) {
  const { nostr } = useNostr();
  // The caller builds a fresh array each render; keying the query on the
  // contents keeps it stable (React Query hashes keys structurally anyway,
  // this just avoids rebuilding the batches needlessly).
  const key = useMemo(() => [...new Set(pubkeys)].sort(), [pubkeys]);

  return useQuery<ReadonlyMap<string, string>>({
    queryKey: ['nostr', 'profile-names', key],
    enabled: key.length > 0,
    staleTime: 5 * 60 * 1000,
    retry: 1,
    queryFn: async () => {
      const batches: string[][] = [];
      for (let i = 0; i < key.length; i += AUTHORS_PER_QUERY) {
        batches.push(key.slice(i, i + AUTHORS_PER_QUERY));
      }

      const responses = await Promise.all(
        batches.map(async (authors) => {
          try {
            return await nostr.query(
              // Addressable (kind:0 is replaceable), so a relay may serve
              // older copies too; take the newest per pubkey below.
              [{ kinds: [0], authors, limit: authors.length * 2 }],
              { signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS) },
            );
          } catch {
            return [] as NostrEvent[];
          }
        }),
      );

      const newest = new Map<string, NostrEvent>();
      for (const event of responses.flat()) {
        if (event.kind !== 0) continue;
        const previous = newest.get(event.pubkey);
        if (!previous || event.created_at > previous.created_at) newest.set(event.pubkey, event);
      }

      const names = new Map<string, string>();
      for (const [pubkey, event] of newest) {
        let metadata: unknown;
        try {
          metadata = JSON.parse(event.content);
        } catch {
          continue;
        }
        if (!metadata || typeof metadata !== 'object') continue;
        const fields = metadata as Record<string, unknown>;
        // display_name is what the author asked to be called; name is their
        // handle; nip05 is a readable fallback when neither is set.
        const name =
          stringField(fields.display_name) ??
          stringField(fields.displayName) ??
          stringField(fields.name) ??
          stringField(fields.nip05);
        if (name) names.set(pubkey, name);
      }

      return names;
    },
  });
}
