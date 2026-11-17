import { lazy, Suspense, useEffect, useId, useRef } from 'react';
import { BookOpenText, ExternalLink, RefreshCw, X } from 'lucide-react';
import { nip19 } from 'nostr-tools';

import type { SearchResult } from '@/lib/api';
import { useArticleEvent, KIND_ARTICLE } from '@/hooks/useArticleEvent';
import { useAuthor } from '@/hooks/useAuthor';
import { Skeleton } from '@/components/ui/skeleton';
import { sanitizeHref } from '@/lib/sanitize';
import { truncateIdentity } from '@/lib/identity';

// react-markdown, remark-gfm and the unified parser stack they pull in are
// ~50 kB gzipped -- a third of this app's initial bundle, for a feature most
// visitors to a results page never open. Split out so it is fetched on the
// first preview instead of on every page load; the dialog shell itself stays
// tiny and always mounted (see the component comment below).
const ArticleMarkdown = lazy(() =>
  import('@/components/ArticleMarkdown').then((m) => ({ default: m.ArticleMarkdown })),
);

const ACTION_LINK_CLASS =
  'inline-flex items-center gap-1 text-sm font-medium text-blue-700 hover:underline dark:text-blue-400';

// A real <dialog> in its top layer, rather than a hand-rolled fixed overlay:
// Escape, background inertness and focus restoration back to the "Preview"
// button all come from the element itself. Desktop gets a centered panel;
// below Tailwind's `sm` breakpoint it becomes a full-screen sheet, which is
// the only layout that leaves a phone a readable column of long-form text.
//
// Nothing here runs until `open` is true: the article query is disabled, so a
// results page never fetches article bodies just by rendering rows.
export function ArticlePreviewDialog({
  result,
  open,
  onClose,
}: {
  result: SearchResult;
  open: boolean;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const article = useArticleEvent(result.pubkey, result.itemId, open);
  const author = useAuthor(open ? result.pubkey : undefined);

  const event = article.data;
  const tag = (name: string): string | null =>
    event?.tags.find((t) => t[0] === name)?.[1]?.trim() || null;

  const displayName = author.data?.metadata?.name?.trim();
  const identity = truncateIdentity(result.nip05 ?? displayName ?? result.npub ?? result.pubkey);
  const title = tag('title') ?? result.title?.trim() ?? identity;
  const summary = tag('summary') ?? tag('description') ?? result.description?.trim() ?? null;
  const cover = sanitizeHref(tag('image') ?? result.thumbnailUrl);

  const publishedAt = (() => {
    if (!event) return null;
    const tagValue = Number(event.tags.find((t) => t[0] === 'published_at')?.[1]);
    const seconds = Number.isFinite(tagValue) && tagValue > 0 ? tagValue : event.created_at;
    return seconds ? new Date(seconds * 1000) : null;
  })();

  const topics = event
    ? [...new Set(event.tags.filter((t) => t[0] === 't' && t[1]).map((t) => t[1]))].slice(0, 6)
    : [];

  // The only way to leave this app with the article itself: no nsite/NCC
  // endpoint exists for a NIP-23 note, so this is the article's relay
  // coordinate opened in a public viewer.
  const njumpHref = (() => {
    try {
      const naddr = nip19.naddrEncode({
        kind: KIND_ARTICLE,
        pubkey: result.pubkey,
        identifier: result.itemId,
      });
      return `https://njump.me/${naddr}`;
    } catch {
      return null;
    }
  })();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    else if (!open && dialog.open) dialog.close();
  }, [open]);

  // A modal dialog already makes the page behind it inert, but the document
  // itself can still scroll on some mobile browsers -- which reads as the
  // sheet sliding while the finger is on the article.
  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open]);

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      onCancel={(e) => {
        // Let React own open/close state instead of the browser closing the
        // element out from under it.
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        // Clicks on the backdrop land on the dialog element itself; anything
        // inside the panel targets a descendant.
        if (e.target === e.currentTarget) onClose();
      }}
      className="m-auto max-h-[85dvh] w-[min(92vw,48rem)] overflow-hidden rounded-xl border border-border bg-background p-0 text-foreground shadow-2xl backdrop:bg-black/60 max-sm:m-0 max-sm:h-dvh max-sm:max-h-none max-sm:w-full max-sm:max-w-none max-sm:rounded-none max-sm:border-0 pointer-coarse:m-0 pointer-coarse:h-dvh pointer-coarse:max-h-none pointer-coarse:w-full pointer-coarse:max-w-none pointer-coarse:rounded-none pointer-coarse:border-0"
    >
      <div className="flex max-h-[85dvh] flex-col max-sm:h-dvh max-sm:max-h-none pointer-coarse:h-dvh pointer-coarse:max-h-none">
        <header className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-2.5 sm:px-5">
          <BookOpenText className="size-4 text-muted-foreground" aria-hidden="true" />
          <span className="text-sm font-medium text-muted-foreground">Article preview</span>
          <div className="ml-auto flex items-center gap-3">
            {njumpHref && (
              <a
                href={njumpHref}
                target="_blank"
                rel="noopener noreferrer nofollow"
                aria-label="Open this article in njump"
                className={ACTION_LINK_CLASS}
              >
                <ExternalLink className="size-3.5" aria-hidden="true" />
                <span className="sm:hidden">njump</span>
                <span className="hidden sm:inline">Open in njump</span>
              </a>
            )}
            <button
              type="button"
              onClick={onClose}
              aria-label="Close article preview"
              className="rounded p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            >
              <X className="size-4" aria-hidden="true" />
            </button>
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain">
          {cover && (
            <img
              src={cover}
              alt=""
              loading="lazy"
              decoding="async"
              referrerPolicy="no-referrer"
              className="max-h-56 w-full border-b border-border bg-accent object-cover sm:max-h-64"
            />
          )}

          <div className="px-4 py-5 sm:px-8 sm:py-6">
            <h1 id={titleId} className="text-xl leading-tight font-semibold break-words text-foreground sm:text-2xl">
              {title}
            </h1>

            <p className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
              <span className="truncate text-emerald-700 dark:text-emerald-400">{identity}</span>
              {publishedAt && (
                <>
                  <span aria-hidden="true">·</span>
                  <time dateTime={publishedAt.toISOString()}>
                    {publishedAt.toLocaleDateString(undefined, {
                      year: 'numeric',
                      month: 'long',
                      day: 'numeric',
                    })}
                  </time>
                </>
              )}
              {!event && article.isPending && (
                <>
                  <span aria-hidden="true">·</span>
                  <span>loading from relays…</span>
                </>
              )}
            </p>

            {topics.length > 0 && (
              <ul className="mt-2 flex flex-wrap gap-1.5" aria-label="Topics">
                {topics.map((topic) => (
                  <li
                    key={topic}
                    className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground"
                  >
                    #{topic}
                  </li>
                ))}
              </ul>
            )}

            {summary && summary !== title && (
              <p className="mt-3 text-base leading-relaxed text-foreground/80 italic">{summary}</p>
            )}

            <hr className="my-5 border-border" />

            {article.isPending ? (
              <ArticleSkeleton />
            ) : article.isError ? (
              <ArticleUnavailable
                message={article.error instanceof Error ? article.error.message : null}
                fallback={result.snippet || result.description || null}
                njumpHref={njumpHref}
                onRetry={() => article.refetch()}
                retrying={article.isFetching}
              />
            ) : event && event.content.trim() ? (
              <div className="text-[15px] break-words">
                <Suspense fallback={<ArticleSkeleton />}>
                  <ArticleMarkdown content={event.content} />
                </Suspense>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                This event has no body text -- only the title and summary above were published.
              </p>
            )}
          </div>
        </div>
      </div>
    </dialog>
  );
}

function ArticleSkeleton() {
  return (
    <div className="space-y-3" aria-label="Loading article" role="status">
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-4 w-11/12" />
      <Skeleton className="h-4 w-4/5" />
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-4 w-2/3" />
    </div>
  );
}

function ArticleUnavailable({
  message,
  fallback,
  njumpHref,
  onRetry,
  retrying,
}: {
  message: string | null;
  fallback: string | null;
  njumpHref: string | null;
  onRetry: () => void;
  retrying: boolean;
}) {
  return (
    <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-3 text-sm text-amber-950 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200">
      <p>Couldn&rsquo;t load the full article from the configured relays.</p>
      {message && <p className="mt-1 text-xs opacity-80">{message}</p>}

      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
        <button
          type="button"
          onClick={onRetry}
          disabled={retrying}
          className="inline-flex items-center gap-1 font-medium hover:underline disabled:opacity-60"
        >
          <RefreshCw className={`size-3.5 ${retrying ? 'animate-spin' : ''}`} aria-hidden="true" />
          {retrying ? 'Trying…' : 'Try again'}
        </button>
        {njumpHref && (
          <a
            href={njumpHref}
            target="_blank"
            rel="noopener noreferrer nofollow"
            className="inline-flex items-center gap-1 font-medium hover:underline"
          >
            <ExternalLink className="size-3.5" aria-hidden="true" />
            Open in njump
          </a>
        )}
      </div>

      {fallback && (
        <div className="mt-3 border-t border-amber-200 pt-3 dark:border-amber-800/60">
          <p className="text-xs font-medium uppercase tracking-wide opacity-70">Indexed excerpt</p>
          <p className="mt-1 leading-relaxed">{fallback}</p>
        </div>
      )}
    </div>
  );
}
