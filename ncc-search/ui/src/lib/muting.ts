import type { SearchResult } from '@/lib/api';
import type { MuteList } from '@/hooks/useMuteList';

/**
 * Whether a signed-in user's NIP-51 mute list means a result should be
 * hidden outright -- its author is muted ('p'), one of its hashtags is
 * muted ('t', article/image/video only), or its visible text contains a
 * muted word ('word'), matched case-insensitively as a substring, the same
 * semantics most NIP-51 clients use for word mutes. `null` (logged out, or
 * the list hasn't loaded yet) mutes nothing.
 */
export function isMuted(result: SearchResult, mute: MuteList | null | undefined): boolean {
  if (!mute) return false;
  if (mute.pubkeys.has(result.pubkey)) return true;

  const hashtags = result.hashtags ?? [];
  if (hashtags.some((tag) => mute.hashtags.has(tag.toLowerCase()))) return true;

  if (mute.words.length > 0) {
    const haystack = `${result.title ?? ''} ${result.description ?? ''} ${result.snippet ?? ''}`.toLowerCase();
    if (mute.words.some((word) => haystack.includes(word))) return true;
  }

  return false;
}
