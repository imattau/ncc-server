import { useInfiniteQuery } from '@tanstack/react-query';

import { search, type SearchSort } from '@/lib/api';

export function useSearch(query: string, pageSize?: number, sort: SearchSort = 'relevance') {
  const trimmed = query.trim();
  return useInfiniteQuery({
    // The sort is part of the key, so changing it starts a fresh page 1
    // instead of appending differently-ordered pages to the old ones.
    queryKey: ['ncc-search', trimmed, pageSize ?? null, sort],
    queryFn: ({ pageParam, signal }) => search(trimmed, { signal, limit: pageSize, offset: pageParam, sort }),
    initialPageParam: 0,
    // Each page's offset is just the count of rows fetched so far -- the
    // index's `rank` order is stable within a query, so this never skips
    // or repeats a row across pages. Live NIP-50 hits (page 1 only, see
    // server.js) don't count towards it: paging the index should never be
    // thrown off by how many live hits happened to tag along.
    getNextPageParam: (lastPage, allPages) =>
      lastPage.hasMore
        ? allPages.reduce((offset, page) => offset + page.results.filter((r) => r.source === 'index').length, 0)
        : undefined,
    enabled: trimmed.length > 0,
    staleTime: 30_000,
    retry: 1,
  });
}
