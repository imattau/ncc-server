import { useEffect, useMemo, useState } from 'react';

import { SearchBar } from '@/components/SearchBar';
import { ResultRow } from '@/components/ResultRow';
import { MediaGridCard } from '@/components/MediaGridCard';
import { LoginButton } from '@/components/LoginButton';
import { SafeSearchToggle } from '@/components/SafeSearchToggle';
import { ThemeToggle } from '@/components/ThemeToggle';
import { Skeleton } from '@/components/ui/skeleton';
import { useQueryState } from '@/hooks/useQueryState';
import { useSearch } from '@/hooks/useSearch';
import { useNip07Login } from '@/hooks/useNip07Login';
import { useFollows } from '@/hooks/useFollows';
import { useInterests } from '@/hooks/useInterests';
import { useSafeSearch } from '@/hooks/useSafeSearch';
import { useTheme } from '@/hooks/useTheme';
import type { SearchResult } from '@/lib/api';
import { rankResults, isFollowed, type PersonalizationContext } from '@/lib/ranking';
import { cn } from '@/lib/utils';

// Requesting more than the default when a logged-in user's follows/
// interests can re-rank the set -- otherwise personalization could only
// ever reorder the same 20 results the backend's own relevance ranking
// already chose, and a followed author just outside that cutoff would
// never surface no matter how strong the boost. 100 is the backend's own
// hard cap (server.js), so there's no reason to ask for less here -- tested
// this against a real signed-in account and found a genuine followed-author
// match sitting at position 57 of 74 for a real query, which the original
// value of 50 would have missed entirely.
const PERSONALIZED_LIMIT = 100;

const WORDMARK = (
  <span className="text-xl font-normal tracking-tight text-foreground select-none sm:text-2xl">
    ncc<span className="text-muted-foreground">search</span>
  </span>
);

type KindFilter = 'all' | 'ncc-service' | 'nsite' | 'article' | 'image' | 'video';

function matchesFilter(result: SearchResult, filter: KindFilter) {
  if (filter === 'all') return true;
  if (filter === 'nsite') return result.kind.startsWith('nsite');
  return result.kind === filter;
}

export function SearchPage() {
  const [query, setQuery] = useQueryState();
  const { pubkey, login, logout } = useNip07Login();
  const follows = useFollows(pubkey);
  const interests = useInterests(pubkey);
  const result = useSearch(query, pubkey ? PERSONALIZED_LIMIT : undefined);
  const hasQuery = query.trim().length > 0;
  const [filter, setFilter] = useState<KindFilter>('all');
  const safeSearch = useSafeSearch();
  const theme = useTheme();

  // A filter chosen for one query shouldn't silently carry over and hide
  // everything for the next one.
  useEffect(() => {
    setFilter('all');
  }, [query]);

  const personalization: PersonalizationContext | null = pubkey
    ? { follows: follows.data ?? new Set(), interests: interests.data ?? new Set() }
    : null;

  // All pages loaded so far, flattened -- "Load more" appends another page
  // rather than replacing what's already on screen (see useSearch).
  const allResults = useMemo(
    () => result.data?.pages.flatMap((page) => page.results) ?? [],
    [result.data],
  );

  // Ranked once here, before filtering/counting, so a kind tab shows a
  // personalized result set too instead of only the "All" tab. Depend on
  // the two Sets directly, not `personalization` itself -- that object
  // literal is rebuilt every render, which would otherwise re-rank on every
  // keystroke/unrelated state change instead of only when the data that
  // actually matters (results, follows, interests) changes.
  const ranked = useMemo(
    () => rankResults(allResults, personalization),
    [allResults, personalization?.follows, personalization?.interests],
  );

  // Safe search hides anything the publisher tagged NIP-68/71
  // `content-warning` on -- see lib/api.ts's `contentWarning` field and
  // src/adapters/media.js server-side. This is a display preference, not a
  // safety guarantee: it trusts the publisher's own tag, nothing more.
  const hiddenCount = useMemo(
    () => (safeSearch.enabled ? ranked.filter((r) => r.contentWarning).length : 0),
    [ranked, safeSearch.enabled],
  );
  const results = useMemo(
    () => (safeSearch.enabled ? ranked.filter((r) => !r.contentWarning) : ranked),
    [ranked, safeSearch.enabled],
  );
  const counts = useMemo(
    () => ({
      all: results.length,
      'ncc-service': results.filter((r) => r.kind === 'ncc-service').length,
      nsite: results.filter((r) => r.kind.startsWith('nsite')).length,
      article: results.filter((r) => r.kind === 'article').length,
      image: results.filter((r) => r.kind === 'image').length,
      video: results.filter((r) => r.kind === 'video').length,
    }),
    [results],
  );
  const filtered = results.filter((r) => matchesFilter(r, filter));
  const isGridView = filter === 'image' || filter === 'video';

  function handleSubmit(value: string) {
    setQuery(value);
  }

  // Landing state: centered wordmark + search box, like a search engine's
  // homepage -- not a hero banner, not a chat prompt.
  if (!hasQuery) {
    return (
      <div className="relative flex min-h-dvh flex-col items-center px-4 pt-[18vh]">
        <div className="absolute top-4 right-4 flex items-center gap-3 sm:top-6 sm:right-8">
          <SafeSearchToggle enabled={safeSearch.enabled} onToggle={safeSearch.toggle} />
          <ThemeToggle theme={theme.theme} onToggle={theme.toggle} />
          <LoginButton pubkey={pubkey} onSignIn={login} onSignOut={logout} />
        </div>
        <h1 className="mb-8">
          <span className="text-5xl font-normal tracking-tight text-foreground select-none">
            ncc<span className="text-muted-foreground">search</span>
          </span>
        </h1>
        <SearchBar defaultValue="" onSubmit={handleSubmit} size="hero" className="max-w-xl" autoFocus />
        <p className="mt-6 max-w-sm text-center text-xs text-muted-foreground">
          Searches NCC-02 service records and nsites discovered across configured Nostr relays.
          {pubkey && ' Signed in: results are prioritized by who you follow and your interests.'}
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
        <div className="ml-auto flex items-center gap-3">
          <SafeSearchToggle enabled={safeSearch.enabled} onToggle={safeSearch.toggle} />
          <ThemeToggle theme={theme.theme} onToggle={theme.toggle} />
          <LoginButton pubkey={pubkey} onSignIn={login} onSignOut={logout} />
        </div>
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
                  No results for &ldquo;{query}&rdquo;
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
                  {hiddenCount > 0 && (
                    <>
                      {' · '}
                      <button
                        type="button"
                        onClick={safeSearch.toggle}
                        className="underline-offset-2 hover:underline"
                      >
                        {hiddenCount} hidden by safe search
                      </button>
                    </>
                  )}
                </p>

                {filtered.length === 0 ? (
                  <p className="max-w-xl text-sm text-foreground/80">
                    No results of this type for &ldquo;{query}&rdquo;.
                  </p>
                ) : isGridView ? (
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
                    {filtered.map((r) => (
                      <MediaGridCard
                        key={`${r.pubkey}:${r.itemId}:${r.source}`}
                        result={r}
                        isFollowed={isFollowed(r, personalization)}
                      />
                    ))}
                  </div>
                ) : (
                  <div className="max-w-2xl">
                    {filtered.map((r) => (
                      <ResultRow
                        key={`${r.pubkey}:${r.itemId}:${r.source}`}
                        result={r}
                        isFollowed={isFollowed(r, personalization)}
                      />
                    ))}
                  </div>
                )}

                {/* Only on the "All" tab -- a kind filter hides most of
                    `results` client-side already, so "load more" there
                    would fetch rows the filter would just hide again. */}
                {filter === 'all' && result.hasNextPage && (
                  <div className="mt-6 max-w-2xl">
                    <button
                      type="button"
                      onClick={() => result.fetchNextPage()}
                      disabled={result.isFetchingNextPage}
                      className="w-full rounded-md border border-border py-2 text-sm text-foreground hover:bg-muted disabled:opacity-60"
                    >
                      {result.isFetchingNextPage ? 'Loading…' : 'Load more'}
                    </button>
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
    { value: 'article', label: 'Articles' },
    { value: 'image', label: 'Images' },
    { value: 'video', label: 'Videos' },
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
