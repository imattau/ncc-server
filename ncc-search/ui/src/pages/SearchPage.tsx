import { useEffect, useMemo, useState } from 'react';

import { SearchBar } from '@/components/SearchBar';
import { ResultRow } from '@/components/ResultRow';
import { Skeleton } from '@/components/ui/skeleton';
import { useQueryState } from '@/hooks/useQueryState';
import { useSearch } from '@/hooks/useSearch';
import type { SearchResult } from '@/lib/api';
import { cn } from '@/lib/utils';

const WORDMARK = (
  <span className="text-xl font-normal tracking-tight text-foreground select-none sm:text-2xl">
    ncc<span className="text-muted-foreground">search</span>
  </span>
);

type KindFilter = 'all' | 'ncc-service' | 'nsite';

function matchesFilter(result: SearchResult, filter: KindFilter) {
  if (filter === 'all') return true;
  if (filter === 'nsite') return result.kind.startsWith('nsite');
  return result.kind === filter;
}

export function SearchPage() {
  const [query, setQuery] = useQueryState();
  const result = useSearch(query);
  const hasQuery = query.trim().length > 0;
  const [filter, setFilter] = useState<KindFilter>('all');

  // A filter chosen for one query shouldn't silently carry over and hide
  // everything for the next one.
  useEffect(() => {
    setFilter('all');
  }, [query]);

  const results = result.data?.results ?? [];
  const counts = useMemo(
    () => ({
      all: results.length,
      'ncc-service': results.filter((r) => r.kind === 'ncc-service').length,
      nsite: results.filter((r) => r.kind.startsWith('nsite')).length,
    }),
    [results],
  );
  const filtered = results.filter((r) => matchesFilter(r, filter));

  function handleSubmit(value: string) {
    setQuery(value);
  }

  // Landing state: centered wordmark + search box, like a search engine's
  // homepage -- not a hero banner, not a chat prompt.
  if (!hasQuery) {
    return (
      <div className="flex min-h-dvh flex-col items-center px-4 pt-[18vh]">
        <h1 className="mb-8">
          <span className="text-5xl font-normal tracking-tight text-foreground select-none">
            ncc<span className="text-muted-foreground">search</span>
          </span>
        </h1>
        <SearchBar defaultValue="" onSubmit={handleSubmit} size="hero" className="max-w-xl" autoFocus />
        <p className="mt-6 max-w-sm text-center text-xs text-muted-foreground">
          Searches NCC-02 service records and nsites discovered across configured Nostr relays.
        </p>
      </div>
    );
  }

  return (
    <div className="min-h-dvh">
      <header className="sticky top-0 z-10 flex items-center gap-4 border-b border-border bg-background/95 px-4 py-3 backdrop-blur-sm sm:gap-6 sm:px-8">
        <button
          type="button"
          onClick={() => setQuery('')}
          className="shrink-0 cursor-pointer rounded outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label="Clear search and return to the start page"
        >
          {WORDMARK}
        </button>
        <SearchBar defaultValue={query} onSubmit={handleSubmit} size="compact" className="max-w-xl" />
      </header>

      <main className="px-4 py-5 sm:px-8">
        {result.isLoading && <ResultsSkeleton />}

        {result.isError && (
          <div className="max-w-2xl py-4">
            <p className="text-sm text-foreground">
              {result.error instanceof Error ? result.error.message : 'Search failed.'}
            </p>
            <button
              type="button"
              onClick={() => result.refetch()}
              className="mt-2 text-sm text-blue-700 hover:underline dark:text-blue-400"
            >
              Try again
            </button>
          </div>
        )}

        {result.data && (
          <>
            {results.length === 0 ? (
              <>
                <p className="mb-3 text-sm text-muted-foreground">
                  No results for &ldquo;{result.data.query}&rdquo;
                </p>
                <p className="max-w-xl text-sm text-foreground/80">
                  Try a different npub, nip05 handle, or service/site name. If this identity was
                  published recently, it may not have been crawled yet.
                </p>
              </>
            ) : (
              <>
                <KindTabs filter={filter} onChange={setFilter} counts={counts} />

                <p className="mb-3 text-sm text-muted-foreground">
                  {filtered.length} of {results.length} result{results.length === 1 ? '' : 's'}
                </p>

                {filtered.length === 0 ? (
                  <p className="max-w-xl text-sm text-foreground/80">
                    No results of this type for &ldquo;{result.data.query}&rdquo;.
                  </p>
                ) : (
                  <div className="max-w-2xl">
                    {filtered.map((r) => (
                      <ResultRow key={`${r.pubkey}:${r.itemId}:${r.source}`} result={r} />
                    ))}
                  </div>
                )}
              </>
            )}
          </>
        )}
      </main>
    </div>
  );
}

function KindTabs({
  filter,
  onChange,
  counts,
}: {
  filter: KindFilter;
  onChange: (filter: KindFilter) => void;
  counts: Record<KindFilter, number>;
}) {
  const tabs: Array<{ value: KindFilter; label: string }> = [
    { value: 'all', label: 'All' },
    { value: 'ncc-service', label: 'NCC services' },
    { value: 'nsite', label: 'Sites' },
  ];

  return (
    <nav className="mb-4 flex gap-5 border-b border-border text-sm" aria-label="Filter by result type">
      {tabs.map((tab) => {
        const count = counts[tab.value];
        if (tab.value !== 'all' && count === 0) return null;
        return (
          <button
            key={tab.value}
            type="button"
            onClick={() => onChange(tab.value)}
            className={cn(
              '-mb-px border-b-2 pb-2 transition-colors',
              filter === tab.value
                ? 'border-foreground font-medium text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {tab.label}
            <span className="ml-1.5 text-xs text-muted-foreground">{count}</span>
          </button>
        );
      })}
    </nav>
  );
}

function ResultsSkeleton() {
  return (
    <div className="max-w-2xl">
      {Array.from({ length: 5 }, (_, i) => (
        <div key={i} className="space-y-2 py-5 first:pt-0">
          <Skeleton className="h-5 w-72" />
          <Skeleton className="h-3.5 w-40" />
          <Skeleton className="h-3.5 w-full max-w-lg" />
          <Skeleton className="h-3.5 w-2/3 max-w-md" />
        </div>
      ))}
    </div>
  );
}
