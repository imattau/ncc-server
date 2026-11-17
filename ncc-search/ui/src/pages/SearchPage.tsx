import { useEffect, useMemo, useState } from 'react';

import { SearchBar } from '@/components/SearchBar';
import { ResultRow } from '@/components/ResultRow';
import { MediaGridCard } from '@/components/MediaGridCard';
import { ProfileGridCard } from '@/components/ProfileGridCard';
import { LoginButton } from '@/components/LoginButton';
import { SortControl } from '@/components/SortControl';
import { SafeSearchToggle } from '@/components/SafeSearchToggle';
import { ThemeToggle } from '@/components/ThemeToggle';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { useQueryState } from '@/hooks/useQueryState';
import { useSearch } from '@/hooks/useSearch';
import { useNip07Login } from '@/hooks/useNip07Login';
import { useFollows } from '@/hooks/useFollows';
import { useInterests } from '@/hooks/useInterests';
import { useMuteList } from '@/hooks/useMuteList';
import { useSafeSearch } from '@/hooks/useSafeSearch';
import { useTheme } from '@/hooks/useTheme';
import type { SearchResult, SearchSort } from '@/lib/api';
import { useSearchStatus } from '@/hooks/useSearchStatus';
import { rankResults, isFollowed, type PersonalizationContext } from '@/lib/ranking';
import { isMuted } from '@/lib/muting';
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

// A little personality for the landing page. The number comes from /status when
// the page opens, so the line is honest rather than a static boast; if the
// status call is slow or unavailable the tagline says so instead of inventing a
// figure. One line is picked per page load, so it doesn't shuffle while the
// count refreshes.
const TAGLINES: Array<(count: string) => string> = [
  (count) => `${count} records, zero tracking pixels, one mildly overworked crawler.`,
  (count) => `Serving ${count} records. Still fewer than your open tabs.`,
  (count) => `${count} records indexed by robots who never sleep. You're welcome.`,
  (count) => `${count} records, a full-text index, and no opinion about your query.`,
  (count) => `${count} records, hand-picked by a crawler with no hands.`,
  (count) => `Serving ${count} records at the speed of Nostr. Your move.`,
];

function landingTagline(recordCount: number | null | undefined, seed: number): string {
  if (recordCount == null) return 'Counting the index…';
  if (recordCount === 0) return 'Zero records. Bold of you to search anyway.';
  return TAGLINES[seed % TAGLINES.length](recordCount.toLocaleString());
}

type KindFilter = 'all' | 'ncc-service' | 'nsite' | 'article' | 'image' | 'video' | 'profile' | 'npack';

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
  const muteList = useMuteList(pubkey);
  const [sort, setSort] = useState<SearchSort>('relevance');
  const result = useSearch(query, pubkey ? PERSONALIZED_LIMIT : undefined, sort);
  const hasQuery = query.trim().length > 0;
  // Also fetched on the landing page: its record count is what the tagline
  // quotes. The same query backs the health notice on the results page.
  const status = useSearchStatus(true);
  const [taglineSeed] = useState(() => Math.floor(Math.random() * TAGLINES.length));
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
  // Follows/interests reorder results by relevance. An explicit Date/A-Z
  // sort is a stronger instruction than that, so it is left alone; the
  // "following" badges still come from the same context.
  const ranked = useMemo(
    () => (sort === 'relevance' ? rankResults(allResults, personalization) : allResults),
    [allResults, personalization?.follows, personalization?.interests, sort],
  );

  // A signed-in user's own NIP-51 mute list hides a muted author/hashtag/
  // word outright -- unlike the follow/interest boost above, there's no
  // toggle to reveal these again here; muting is the user's own explicit
  // call, made on their real social graph, not a per-publisher label like
  // the content-warning safe search filters below.
  const mutedCount = useMemo(
    () => ranked.filter((r) => isMuted(r, muteList.data)).length,
    [ranked, muteList.data],
  );
  const afterMute = useMemo(
    () => ranked.filter((r) => !isMuted(r, muteList.data)),
    [ranked, muteList.data],
  );

  // Safe search hides anything the publisher tagged NIP-68/71
  // `content-warning` on -- see lib/api.ts's `contentWarning` field and
  // src/adapters/media.js server-side. This is a display preference, not a
  // safety guarantee: it trusts the publisher's own tag, nothing more.
  const hiddenCount = useMemo(
    () => (safeSearch.enabled ? afterMute.filter((r) => r.contentWarning).length : 0),
    [afterMute, safeSearch.enabled],
  );
  const results = useMemo(
    () => (safeSearch.enabled ? afterMute.filter((r) => !r.contentWarning) : afterMute),
    [afterMute, safeSearch.enabled],
  );
  const counts = useMemo(
    () => ({
      all: results.length,
      'ncc-service': results.filter((r) => r.kind === 'ncc-service').length,
      nsite: results.filter((r) => r.kind.startsWith('nsite')).length,
      article: results.filter((r) => r.kind === 'article').length,
      image: results.filter((r) => r.kind === 'image').length,
      video: results.filter((r) => r.kind === 'video').length,
      profile: results.filter((r) => r.kind === 'profile').length,
      npack: results.filter((r) => r.kind === 'npack').length,
    }),
    [results],
  );
  const filtered = results.filter((r) => matchesFilter(r, filter));
  const isGridView = filter === 'image' || filter === 'video' || filter === 'profile';
  const GridCard = filter === 'profile' ? ProfileGridCard : MediaGridCard;

  function handleSubmit(value: string) {
    setQuery(value);
  }

  // Landing state: centered wordmark + search box, like a search engine's
  // homepage -- not a hero banner, not a chat prompt.
  if (!hasQuery) {
    return (
      <div className="relative flex min-h-dvh flex-col items-center px-4 pt-[18vh] [overflow-wrap:anywhere]">
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
        <p className="mt-6 max-w-sm text-center text-sm text-muted-foreground">
          {landingTagline(status.data?.index?.recordCount, taglineSeed)}
        </p>
        <p className="mt-2 max-w-sm text-center text-[11px] text-muted-foreground/80">
          NCC-02 services, nsites, articles, media and profiles discovered across configured Nostr
          relays.
          {pubkey &&
            ' Signed in: results are prioritized by who you follow and your interests, and anyone/anything on your mute list is hidden.'}
        </p>
      </div>
    );
  }

  return (
    <div className="min-h-dvh [overflow-wrap:anywhere]">
      <header className="sticky top-0 z-10 flex flex-wrap items-center gap-x-4 gap-y-3 border-b border-border bg-background/95 px-3 py-3 backdrop-blur-sm sm:flex-nowrap sm:gap-6 sm:px-8">
        <button
          type="button"
          onClick={() => setQuery('')}
          className="shrink-0 cursor-pointer rounded outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label="Clear search and return to the start page"
        >
          {WORDMARK}
        </button>
        <SearchBar defaultValue={query} onSubmit={handleSubmit} size="compact" className="order-3 max-w-xl basis-full sm:order-none sm:basis-auto" />
        <div className="ml-auto flex items-center gap-2 sm:gap-3">
          <SafeSearchToggle enabled={safeSearch.enabled} onToggle={safeSearch.toggle} />
          <ThemeToggle theme={theme.theme} onToggle={theme.toggle} />
          <LoginButton pubkey={pubkey} onSignIn={login} onSignOut={logout} />
        </div>
      </header>

      <main className="px-3 py-5 sm:px-8">
        {status.data && <SearchHealthNotice status={status.data} />}
        {result.isLoading && <ResultsSkeleton />}

        {result.isError && (
          <div className="max-w-2xl py-4">
            <p className="text-sm text-foreground">
              {result.error instanceof Error ? result.error.message : 'Search failed.'}
            </p>
            <Button
              type="button"
              variant="link"
              size="sm"
              onClick={() => result.refetch()}
              className="mt-2 px-0 text-blue-700 dark:text-blue-400"
            >
              Try again
            </Button>
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

                <div className="mb-3 flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
                  <p className="text-sm text-muted-foreground">
                    {filtered.length} of {results.length} result{results.length === 1 ? '' : 's'}
                    {mutedCount > 0 && (
                      <>
                        {' · '}
                        {mutedCount} muted
                      </>
                    )}
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
                  <SortControl sort={sort} onChange={setSort} />
                </div>

                {filtered.length === 0 ? (
                  <p className="max-w-xl text-sm text-foreground/80">
                    No results of this type for &ldquo;{query}&rdquo;.
                  </p>
                ) : isGridView ? (
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
                    {filtered.map((r) => (
                      <GridCard
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
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => result.fetchNextPage()}
                      disabled={result.isFetchingNextPage}
                      className="w-full"
                    >
                      {result.isFetchingNextPage ? 'Loading…' : 'Load more'}
                    </Button>
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

function SearchHealthNotice({ status }: { status: NonNullable<ReturnType<typeof useSearchStatus>['data']> }) {
  const availability = Object.values(status.crawlers).filter((crawler) =>
    crawler.incomplete ?? crawler.state === 'unavailable',
  );
  // The crawler process itself being unreachable is the same signal as every
  // source being incomplete: the index is still served, but it is no longer
  // being refreshed and its freshness is unknown.
  const crawlerUnreachable = status.crawlersUnavailable === true;
  const incomplete = availability.length > 0 || crawlerUnreachable;
  const storage = status.index?.storage;
  const nearLimit = Boolean(storage?.limitBytes && storage.databaseBytes >= storage.limitBytes * 0.8);
  if (!incomplete && !nearLimit) return null;

  return (
    <aside role="status" className="mb-4 max-w-2xl rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-950 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200">
      {incomplete ? 'Some search sources are reconnecting; results may be incomplete.' : null}
      {nearLimit ? `${incomplete ? ' ' : ''}The search index is nearing its configured storage limit.` : null}
    </aside>
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
    { value: 'profile', label: 'Profiles' },
    { value: 'npack', label: 'Packages' },
  ];

  return (
    <nav className="mb-4 flex gap-5 overflow-x-auto border-b border-border text-sm [scrollbar-width:none] [&::-webkit-scrollbar]:hidden" aria-label="Filter by result type">
      {tabs.map((tab) => {
        const count = counts[tab.value];
        if (tab.value !== 'all' && count === 0) return null;
        return (
          <button
            key={tab.value}
            type="button"
            onClick={() => onChange(tab.value)}
            className={cn(
              '-mb-px shrink-0 border-b-2 pb-2 transition-colors',
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
