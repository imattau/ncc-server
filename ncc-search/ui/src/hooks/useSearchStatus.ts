import { useQuery } from '@tanstack/react-query';

import { getStatus } from '@/lib/api';

export function useSearchStatus(enabled = true) {
  return useQuery({
    queryKey: ['ncc-search-status'],
    queryFn: ({ signal }) => getStatus(signal),
    staleTime: 30_000,
    refetchInterval: 60_000,
    retry: 1,
    enabled,
  });
}
