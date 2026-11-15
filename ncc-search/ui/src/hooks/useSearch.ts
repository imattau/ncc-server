import { useInfiniteQuery } from '@tanstack/react-query';

import { search } from '@/lib/api';

export function useSearch(query: string, pageSize?: number) {
  const trimmed = query.trim();
  return useInfiniteQuery({
    queryKey: ['ncc-search', trimmed, pageSize ?? null],
    queryFn: ({ pageParam, signal }) => search(trimmed, { signal, limit: pageSize, offset: pageParam }),
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
