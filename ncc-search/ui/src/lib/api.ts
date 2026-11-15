export type ResultKind =
  | 'ncc-service'
  | 'nsite-root'
  | 'nsite-named'
  | 'article'
  | 'image'
  | 'video';

export interface SearchResult {
  pubkey: string;
  npub?: string | null;
  nip05?: string | null;
  itemId: string;
  kind: ResultKind;
  endpoint?: string | null;
  anchored?: number;
  attestationCount?: number;
  lastReachableAt?: number | null;
  // For ncc-service/nsite rows, the backend's own reachability check.
  // Always null for article/image/video: this backend never fetches media
  // bytes or re-renders article content, so it has no reachability claim to
  // make for those kinds -- see ../../README.md and media.js's module
  // comment. The browser checks media reachability itself (useMediaProbe).
  lastStatus?: number | null;
  title?: string | null;
  description?: string | null;
  snippet?: string;
  // image/video only -- the actual media URL and MIME type. Never fetched
  // by the backend; the browser loads it directly (see ResultRow.tsx).
  mediaUrl?: string | null;
  mediaType?: string | null;
  // image/video: a poster/preview image. For articles, the NIP-23 `image`
  // (cover) tag.
  thumbnailUrl?: string | null;
  // image/video only -- NIP-68/71 imeta placeholder fields. `blurhash` is
  // decoded client-side into an instant low-res preview (see
  // useBlurhashPlaceholder) while the real image loads/resizes. `thumbhash`
  // is carried through but not currently decoded (different binary
  // encoding, no decoder implemented).
  blurhash?: string | null;
  thumbhash?: string | null;
  // article/image/video only -- NIP-23/68/71 `t` tags, lowercased. null for
  // ncc-service/nsite (no hashtag concept in those conventions). Used only
  // for client-side ranking against a logged-in user's interests (see
  // lib/ranking.ts) -- this backend computes no ranking itself.
  hashtags?: string[] | null;
  // 'index' = resolved/verified by the backend crawler (or, for
  // article/image/video, simply discovered -- there's nothing to verify);
  // 'live' = a just-found NIP-50 relay hit, not yet even discovered by the
  // ambient crawl -- see ../../README.md's "Live hits are unverified by
  // construction".
  source: 'index' | 'live';
  eventId?: string;
}

export interface SearchResponse {
  query: string;
  results: SearchResult[];
}

const API_BASE = import.meta.env.VITE_NCC_SEARCH_API_BASE ?? 'http://127.0.0.1:7780';

export async function search(
  query: string,
  opts: { limit?: number; signal?: AbortSignal } = {},
): Promise<SearchResponse> {
  const url = new URL('/search', API_BASE);
  url.searchParams.set('q', query);
  if (opts.limit) url.searchParams.set('limit', String(opts.limit));

  const res = await fetch(url, { signal: opts.signal });
  if (!res.ok) {
    let message = `Search failed (HTTP ${res.status})`;
    try {
      const body = await res.json();
      if (body?.error) message = body.error;
    } catch {
      // keep the generic message
    }
    throw new Error(message);
  }
  return res.json();
}
