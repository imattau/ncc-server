export type ResultKind =
  | 'ncc-service'
  | 'nsite-root'
  | 'nsite-named'
  | 'article'
  | 'image'
  | 'video'
  | 'profile'
  | 'npack';

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
  /** Unix milliseconds when the local index row was last resolved or updated. */
  indexedAt?: number | null;
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
  // npack: the artifact's download URL/MIME type (its kind:1063 NIP-94
  // event), null until that event has been seen -- see
  // src/adapters/npack-crawl.js.
  mediaUrl?: string | null;
  mediaType?: string | null;
  // image/video: a poster/preview image. For articles, the NIP-23 `image`
  // (cover) tag. For profiles, the kind:0 `picture` field.
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
  // image/video only -- the NIP-68/71 `content-warning` tag's value (or a
  // generic label if present with no reason text), null if absent. Used by
  // useSafeSearch to filter/label; this backend makes no safety judgment
  // itself, it only exposes what the publisher tagged.
  contentWarning?: string | null;
  // 'index' = resolved/verified by the backend crawler (or, for
  // article/image/video, simply discovered -- there's nothing to verify);
  // 'live' = a just-found NIP-50 relay hit, not yet even discovered by the
  // ambient crawl -- see ../../README.md's "Live hits are unverified by
  // construction".
  source: 'index' | 'live';
  eventId?: string;
  /** Other records from the same publisher with identical kind/title/description, collapsed into this one. */
  alternates?: Array<{ itemId: string; kind: ResultKind }>;
}

export interface SearchResponse {
  query: string;
  results: SearchResult[];
  // Whether another page of index results exists beyond this one -- see
  // useSearch's useInfiniteQuery and the "Load more" button in
  // SearchPage.tsx. Live NIP-50 hits never affect this; they're only ever
  // attached to the first page (see server.js).
  hasMore: boolean;
}

export interface CrawlerStatus {
  relayCount: number;
  connectedRelays: number;
  connectingRelays: number;
  failedRelays: number;
  failureCount: number;
  processingFailureCount: number;
  lastEventAt: number | null;
  lastSuccessfulSyncAt: number | null;
  lastFailureAt: number | null;
  state: 'starting' | 'healthy' | 'degraded' | 'unavailable';
  /** True only when no relay is connected or the last sync is stale; drives the "incomplete" notice. */
  incomplete?: boolean;
  stale?: boolean;
  relays?: Array<{
    url: string;
    connected: boolean | null;
    failureCount: number;
    lastError: string | null;
  }>;
}

export interface SearchStatus {
  ok: boolean;
  checkedAt: number;
  index: {
    recordCount: number;
    rowsByKind: Record<string, number>;
    storage: { databaseBytes: number; diskBytes: number; limitBytes: number | null; freeBytes: number | null };
  } | null;
  crawlers: Record<string, CrawlerStatus>;
}

const API_BASE = import.meta.env.VITE_NCC_SEARCH_API_BASE
  ?? (import.meta.env.DEV ? 'http://127.0.0.1:7780' : window.location.origin);

export async function search(
  query: string,
  opts: { limit?: number; offset?: number; signal?: AbortSignal } = {},
): Promise<SearchResponse> {
  const url = new URL('/search', API_BASE);
  url.searchParams.set('q', query);
  if (opts.limit) url.searchParams.set('limit', String(opts.limit));
  if (opts.offset) url.searchParams.set('offset', String(opts.offset));

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

export async function getStatus(signal?: AbortSignal): Promise<SearchStatus> {
  const res = await fetch(new URL('/status', API_BASE), { signal });
  if (!res.ok) throw new Error(`Status unavailable (HTTP ${res.status})`);
  return res.json() as Promise<SearchStatus>;
}
