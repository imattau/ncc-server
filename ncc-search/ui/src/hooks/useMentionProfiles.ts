import { type NostrEvent } from '@nostrify/nostrify';
import { useNostr } from '@nostrify/react';
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';

import { profilePubkeysInContent } from '@/lib/nostrReferences';

// Most relays cap the number of values in one filter, so a long article that
// mentions fifty people is fetched in a few batches rather than one filter
// some relays would truncate.
const AUTHORS_PER_QUERY = 40;
const LOOKUP_TIMEOUT_MS = 4_000;

function stringField(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * Display names for the people a `nostr:` reference points at, so a preview
 * can show "@alice" instead of a 63-character bech32 blob.
 *
 * Deliberately client-side, like the article fetch and the byline's author
 * lookup: the search backend is an index, and resolving a mention's current
 * kind:0 is something the reader's own browser can do without that being
 * proxied or cached anywhere. Failure is not an error state -- the mention
 * still renders, just with a shortened npub -- so a slow or unreachable relay
 * never costs the reader the article text.
 */
export function useMentionProfiles(content: string) {
  const { nostr } = useNostr();
  const pubkeys = useMemo(() => profilePubkeysInContent(content), [content]);

  return useQuery<ReadonlyMap<string, string>>({
    queryKey: ['nostr', 'mention-profiles', pubkeys],
    enabled: pubkeys.length > 0,
    staleTime: 5 * 60 * 1000,
    retry: 1,
    queryFn: async () => {
      const batches: string[][] = [];
      for (let i = 0; i < pubkeys.length; i += AUTHORS_PER_QUERY) {
        batches.push(pubkeys.slice(i, i + AUTHORS_PER_QUERY));
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
