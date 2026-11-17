import { type NostrEvent, type NostrFilter } from '@nostrify/nostrify';
import { useNostr } from '@nostrify/react';
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';

import { noteReferencesInContent, type NoteReference } from '@/lib/nostrReferences';

// Relays disagree on how many ids one filter may carry; 100 is comfortably
// below every cap we have seen.
const IDS_PER_FILTER = 100;
const LOOKUP_TIMEOUT_MS = 6_000;

const NO_NOTES: ReadonlyMap<string, NostrEvent> = new Map();

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// Metadata and list events carry JSON, not prose (kind:0 profiles, kind:3
// follow lists, the 10000-series replaceable lists). A quote card would print
// that JSON at the reader, so those references keep the shortened-link
// fallback instead.
function hasQuotableContent(event: NostrEvent) {
  return event.kind !== 0 && event.kind !== 3 && !(event.kind >= 10000 && event.kind < 20000);
}

function matchesReference(event: NostrEvent, reference: NoteReference) {
  if (reference.kind === 'event') return event.id === reference.id;
  const { kind, pubkey, identifier } = reference.address;
  return (
    event.kind === kind &&
    event.pubkey === pubkey &&
    event.tags.some((tag) => tag[0] === 'd' && tag[1] === identifier)
  );
}

/**
 * The events an article points at with `note`/`nevent`/`naddr`, fetched once
 * per preview so the body can show a quoted note instead of a 60-character
 * bech32 string.
 *
 * The lookup stays on the relays this page is already configured for, in the
 * reader's browser. A reference may carry its own relay hints, but dialling
 * those would mean an article author could point every reader at a host of
 * their choosing; a note that truly exists nowhere else falls back to a
 * shortened reference linking to njump.
 */
export function useQuotedNotes(content: string) {
  const { nostr } = useNostr();
  const references = useMemo(() => noteReferencesInContent(content), [content]);
  const keys = useMemo(() => references.map((reference) => reference.key), [references]);

  const query = useQuery<ReadonlyMap<string, NostrEvent>>({
    queryKey: ['nostr', 'quoted-notes', keys],
    enabled: references.length > 0,
    staleTime: 5 * 60 * 1000,
    retry: 1,
    queryFn: async () => {
      const filters: NostrFilter[] = [];
      const ids = references.flatMap((reference) => (reference.kind === 'event' ? [reference.id] : []));
      for (const batch of chunks(ids, IDS_PER_FILTER)) filters.push({ ids: batch });

      // One exact coordinate per `naddr`: combining several addresses into a
      // single filter would ask for the cross product of authors and `d` tags
      // and rely on the relay to filter the pairing for us.
      for (const reference of references) {
        if (reference.kind !== 'address') continue;
        const { kind, pubkey, identifier } = reference.address;
        filters.push({ kinds: [kind], authors: [pubkey], '#d': [identifier], limit: 2 });
      }

      const responses = await Promise.all(
        filters.map(async (filter) => {
          try {
            return await nostr.query([filter], { signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS) });
          } catch {
            return [] as NostrEvent[];
          }
        }),
      );

      const events = responses.flat();
      const found = new Map<string, NostrEvent>();
      for (const reference of references) {
        // Newest first for addressable targets: a relay may still hold a
        // replaced copy of the same coordinate.
        const matches = events
          .filter((event) => matchesReference(event, reference) && hasQuotableContent(event))
          .sort((a, b) => b.created_at - a.created_at);
        if (matches[0]) found.set(reference.key, matches[0]);
      }
      return found;
    },
  });

  return {
    byKey: query.data ?? NO_NOTES,
    // True only while a lookup that could still produce a quote is running;
    // an article with no references never shows a loading state.
    pending: references.length > 0 && query.isPending,
  };
}
