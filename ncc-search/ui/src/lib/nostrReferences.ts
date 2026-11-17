import { nip19 } from 'nostr-tools';

// NIP-21 / NIP-19 references embedded in article text. This is the one place
// that knows the shape of a `nostr:` URI and what it decodes to; the markdown
// renderer uses it both to linkify bare references and to decide what to show
// in their place. Bech32's charset excludes `1`, `b`, `i` and `o`, but the
// regex stays permissive and `nip19.decode` is the real validator -- a
// malformed match simply isn't a reference.
export const NOSTR_URI_SOURCE = 'nostr:(?:npub|nprofile|note|nevent|naddr)1[a-z0-9]+';

/** Global matcher, for scanning a whole article body. */
export const NOSTR_URI_RE = new RegExp(NOSTR_URI_SOURCE, 'gi');

/** Non-global matcher: safe for `test()` without mutating `lastIndex`. */
export const NOSTR_URI_TEST_RE = new RegExp(NOSTR_URI_SOURCE, 'i');

/** Anchored matcher, for "is this whole string a reference?". */
export const NOSTR_URI_EXACT_RE = new RegExp(`^${NOSTR_URI_SOURCE}$`, 'i');

export type NostrReference =
  | { kind: 'profile'; uri: string; bech32: string; pubkey: string }
  | { kind: 'event'; uri: string; bech32: string }
  | { kind: 'address'; uri: string; bech32: string };

/**
 * Decode one `nostr:` URI. Returns null for anything that isn't a complete,
 * decodable public reference -- including `nsec`, which must never be turned
 * into a link even if an author accidentally pastes one.
 */
export function parseNostrReference(value: string | null | undefined): NostrReference | null {
  if (!value) return null;
  const uri = value.trim();
  if (!NOSTR_URI_EXACT_RE.test(uri)) return null;

  const bech32 = uri.slice('nostr:'.length);
  let decoded: ReturnType<typeof nip19.decode>;
  try {
    decoded = nip19.decode(bech32);
  } catch {
    return null;
  }

  switch (decoded.type) {
    case 'npub':
      return { kind: 'profile', uri, bech32, pubkey: decoded.data };
    case 'nprofile':
      return { kind: 'profile', uri, bech32, pubkey: decoded.data.pubkey };
    case 'note':
    case 'nevent':
      return { kind: 'event', uri, bech32 };
    case 'naddr':
      return { kind: 'address', uri, bech32 };
    default:
      return null;
  }
}

/**
 * Every pubkey mentioned as `nostr:npub…`/`nostr:nprofile…` in a body of
 * text, deduplicated -- this is what a preview resolves names for.
 */
export function profilePubkeysInContent(content: string): string[] {
  const pubkeys = new Set<string>();
  for (const match of content.matchAll(NOSTR_URI_RE)) {
    const reference = parseNostrReference(match[0]);
    if (reference?.kind === 'profile') pubkeys.add(reference.pubkey);
  }
  return [...pubkeys];
}
