import { useEffect, useRef } from 'react';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';

import { search, type SearchSort } from '@/lib/api';
import { isLocalMode, subscribeLocalStatus } from '@/lib/local/client';

export function useSearch(query: string, pageSize?: number, sort: SearchSort = 'relevance') {
  const trimmed = query.trim();
  const queryClient = useQueryClient();
  const local = isLocalMode();
  const lastVersion = useRef<number | null>(null);

  // The local index grows while the reader is on the page, so results would
  // otherwise be a snapshot of whatever had been crawled at query time. This
  // refetches when rows change, coalesced to one refetch every few seconds --
  // a crawl can accept hundreds of events per second, and a refetch per event
  // would be its own denial of service.
  useEffect(() => {
    if (!local) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = subscribeLocalStatus((status) => {
      if (lastVersion.current === null) {
        lastVersion.current = status.version;
        return;
      }
      if (status.version === lastVersion.current) return;
      lastVersion.current = status.version;
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        void queryClient.invalidateQueries({ queryKey: ['ncc-search'] });
      }, 3_000);
    });
    return () => {
      unsubscribe();
      if (timer) clearTimeout(timer);
    };
  }, [local, queryClient]);

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
