import { useQuery } from '@tanstack/react-query';

import { getStatus } from '@/lib/api';
import { isLocalMode } from '@/lib/local/client';

export function useSearchStatus(enabled = true) {
  // The local index reports its own crawl progress instead of a server's
  // health; on the landing page that is what drives the live record count, so
  // it needs to keep up with a crawl that is visibly moving.
  const local = isLocalMode();
  return useQuery({
    queryKey: ['ncc-search-status', local ? 'local' : 'remote'],
    queryFn: ({ signal }) => getStatus(signal),
    staleTime: local ? 1_000 : 30_000,
    refetchInterval: local ? 3_000 : 60_000,
    retry: 1,
    enabled,
  });
}
