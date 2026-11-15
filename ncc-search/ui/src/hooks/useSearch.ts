import { useQuery } from '@tanstack/react-query';

import { search } from '@/lib/api';

export function useSearch(query: string, limit?: number) {
  const trimmed = query.trim();
  return useQuery({
    queryKey: ['ncc-search', trimmed, limit ?? null],
    queryFn: ({ signal }) => search(trimmed, { signal, limit }),
    enabled: trimmed.length > 0,
    staleTime: 30_000,
    retry: 1,
  });
}
