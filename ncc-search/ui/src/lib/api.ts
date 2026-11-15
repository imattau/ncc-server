export interface SearchResult {
  pubkey: string;
  npub?: string | null;
  nip05?: string | null;
  itemId: string;
  kind: 'ncc-service' | 'nsite-root' | 'nsite-named';
  endpoint?: string | null;
  anchored?: number;
  attestationCount?: number;
  lastReachableAt?: number | null;
  lastStatus?: number | null;
  title?: string | null;
  description?: string | null;
  snippet?: string;
  // 'index' = resolved/fetched/verified by the backend crawler;
  // 'live' = a just-found NIP-50 relay hit, not yet verified -- see
  // ../../README.md's "Live hits are unverified by construction".
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
