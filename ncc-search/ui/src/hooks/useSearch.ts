import { useQuery } from '@tanstack/react-query';

import { search } from '@/lib/api';

export function useSearch(query: string) {
  const trimmed = query.trim();
  return useQuery({
    queryKey: ['ncc-search', trimmed],
    queryFn: ({ signal }) => search(trimmed, { signal }),
    enabled: trimmed.length > 0,
    staleTime: 30_000,
    retry: 1,
  });
}
