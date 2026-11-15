import { useNostr } from '@nostrify/react';
import { useQuery } from '@tanstack/react-query';

const KIND_MUTE_LIST = 10000; // NIP-51, standard (non-addressable) mute list

export interface MuteList {
  pubkeys: Set<string>;
  hashtags: Set<string>; // lowercased
  words: string[]; // lowercased, for a case-insensitive substring match
}

const EMPTY_MUTE_LIST: MuteList = { pubkeys: new Set(), hashtags: new Set(), words: [] };

/**
 * The logged-in NIP-07 pubkey's NIP-51 mute list (kind:10000), used by
 * lib/muting.ts's isMuted() to hide results in SearchPage.tsx outright --
 * unlike ranking.ts's follow/interest boosts, which only reorder.
 *
 * Public entries only (the event's own 'p'/'t'/'word' tags). NIP-51 also
 * lets a user keep "private" mutes NIP-04-encrypted (to themselves) in the
 * event's `content`; decrypting that needs a signer round-trip
 * (window.nostr.nip04.decrypt) this app never makes -- see
 * useNip07Login.ts's own comment on why it never asks for more than
 * getPublicKey. A private mute is silently not applied here, the same way
 * useInterests.ts skips kind:10015's `a`-tag referenced sets.
 */
export function useMuteList(pubkey: string | null) {
  const { nostr } = useNostr();

  return useQuery<MuteList>({
    queryKey: ['nostr', 'mute-list', pubkey ?? ''],
    queryFn: async () => {
      if (!pubkey) return EMPTY_MUTE_LIST;
      const [event] = await nostr.query([{ kinds: [KIND_MUTE_LIST], authors: [pubkey], limit: 1 }], {
        signal: AbortSignal.timeout(4000),
      });
      if (!event) return EMPTY_MUTE_LIST;

      const pubkeys = new Set<string>();
      const hashtags = new Set<string>();
      const words: string[] = [];
      for (const tag of event.tags) {
        if (tag[0] === 'p' && tag[1]) pubkeys.add(tag[1]);
        else if (tag[0] === 't' && tag[1]) hashtags.add(tag[1].toLowerCase());
        else if (tag[0] === 'word' && tag[1]) words.push(tag[1].toLowerCase());
      }
      return { pubkeys, hashtags, words };
    },
    enabled: !!pubkey,
    staleTime: 10 * 60 * 1000,
    retry: 1,
  });
}
