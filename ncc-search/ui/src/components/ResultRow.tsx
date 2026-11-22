import { useState, type MouseEvent } from 'react';
import { BookOpenText, EyeOff, Image as ImageIcon, Play, Video as VideoIcon } from 'lucide-react';
import type { ResultKind, SearchResult } from '@/lib/api';
import { useAuthor } from '@/hooks/useAuthor';
import { useMediaProbe } from '@/hooks/useMediaProbe';
import { useResizedImage } from '@/hooks/useResizedImage';
import { useBlurhashPlaceholder } from '@/hooks/useBlurhashPlaceholder';
import { mediaPreviewTarget } from '@/lib/mediaPreview';
import { shouldBlurMedia } from '@/lib/nsfw';
import { nsiteHref, sanitizeHref } from '@/lib/sanitize';
import { cn } from '@/lib/utils';
import { truncateIdentity } from '@/lib/identity';
import { Snippet } from '@/components/Snippet';
import { ArticlePreviewDialog } from '@/components/ArticlePreviewDialog';
import { MediaPreviewDialog } from '@/components/MediaPreviewDialog';

const KIND_LABEL: Record<ResultKind, string> = {
  'ncc-service': 'NCC service',
  'nsite-root': 'nsite',
  'nsite-named': 'nsite',
  article: 'article',
  image: 'image',
  video: 'video',
  'short-video': 'short video',
  event: 'event',
  'live-stream': 'live stream',
  profile: 'profile',
  npack: 'package',
};

const MEDIA_KINDS = new Set<ResultKind>(['image', 'video', 'short-video']);
const VIDEO_KINDS = new Set<ResultKind>(['video', 'short-video']);

/** NIP-52/NIP-53 start time; all-day events show a date without a time. */
function scheduleLabel(result: SearchResult): string | null {
  if (result.startsAt == null) return null;
  const start = new Date(result.startsAt);
  if (Number.isNaN(start.getTime())) return null;
  return start.toLocaleString(undefined, result.allDay
    ? { dateStyle: 'medium', timeZone: 'UTC' }
    : { dateStyle: 'medium', timeStyle: 'short' });
}

/**
 * NIP-53's status is publisher-declared. The spec itself says a `live` event
 * with no update for an hour may be considered ended, so a stale claim is
 * labelled rather than shown as a confident red LIVE chip.
 */
function liveLabel(result: SearchResult): { text: string; tone: 'live' | 'muted' } | null {
  if (result.kind !== 'live-stream') return null;
  if (result.liveStatus === 'live') {
    const stale = typeof result.postedAt === 'number'
      && Date.now() - result.postedAt > 60 * 60_000;
    return stale
      ? { text: 'live · may have ended', tone: 'muted' }
      : { text: 'LIVE', tone: 'live' };
  }
  if (result.liveStatus === 'planned') return { text: 'planned', tone: 'muted' };
  if (result.liveStatus === 'ended') return { text: 'ended', tone: 'muted' };
  return null;
}

// Deterministic from the pubkey, not loaded from anywhere -- real search
// engines show a site favicon on this line; this is the equivalent for an
// identity that has no icon of its own, without calling out to a
// third-party favicon service (which would leak every search's targets to
// it) or waiting on a network fetch per result.
function hashHue(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i++) {
    hash = (hash * 31 + value.charCodeAt(i)) >>> 0;
  }
  return hash % 360;
}

function IdentityMark({ seed, letter }: { seed: string; letter: string }) {
  return (
    <span
      aria-hidden="true"
      className="inline-flex size-4 shrink-0 items-center justify-center rounded-full text-[9px] font-semibold text-white"
      style={{ backgroundColor: `hsl(${hashHue(seed)} 55% 42%)` }}
    >
      {letter}
    </span>
  );
}

type DotTone = 'amber' | 'emerald' | 'muted';
interface StatusInfo {
  label: string;
  tone: DotTone;
  pulse?: boolean;
}

const DOT_TONE_CLASS: Record<DotTone, string> = {
  amber: 'bg-amber-500',
  emerald: 'bg-emerald-500',
  muted: 'bg-muted-foreground/50',
};
const TEXT_TONE_CLASS: Record<DotTone, string> = {
  amber: 'text-amber-700 dark:text-amber-500',
  emerald: 'text-emerald-700 dark:text-emerald-500',
  muted: 'text-muted-foreground',
};

// Server-checked reachability (ncc-service/nsite) vs. client-checked
// (image/video, via the Web Worker in useMediaProbe -- this backend never
// fetches media bytes itself, see src/adapters/media.js). Exactly one of
// these ever applies to a given result; never both. Returns null when there
// is genuinely nothing to report (e.g. an unfetched nsite row, or an
// article -- which has no reachability concept at all), so the caller can
// skip rendering the "·" separator entirely instead of leaving one dangling.
//
// Deliberately NOT derived from useResizedImage's success/failure: a resize
// failure commonly means the host didn't send CORS headers for the
// worker's cross-origin read, which says nothing about whether the file is
// actually reachable -- a plain `<img src>` doesn't need CORS to render. The
// lightweight no-cors HEAD probe here (same one video uses) is the honest
// signal; the resize pipeline is purely a rendering optimization, not a
// reachability check.
function useResultStatus(result: SearchResult): StatusInfo | null {
  const isMedia = MEDIA_KINDS.has(result.kind);
  const mediaStatus = useMediaProbe(isMedia ? result.mediaUrl : null);

  if (result.source === 'live') {
    return { label: 'just found, unverified', tone: 'amber' };
  }
  if (isMedia) {
    if (mediaStatus === 'reachable') return { label: 'reachable', tone: 'emerald' };
    if (mediaStatus === 'unreachable') return { label: 'unreachable', tone: 'muted' };
    return { label: 'checking…', tone: 'muted', pulse: true };
  }
  if (result.lastStatus != null) {
    return result.lastStatus < 400
      ? { label: 'reachable', tone: 'emerald' }
      : { label: 'unreachable', tone: 'muted' };
  }
  return null;
}

function StatusDot({ status }: { status: StatusInfo }) {
  return (
    <span className={`inline-flex items-center gap-1 ${TEXT_TONE_CLASS[status.tone]}`}>
      <span
        className={`size-1.5 rounded-full ${DOT_TONE_CLASS[status.tone]} ${status.pulse ? 'animate-pulse' : ''}`}
        aria-hidden="true"
      />
      {status.label}
    </span>
  );
}

const COMPACT_THUMB_CLASS =
  'size-20 shrink-0 rounded-md border border-border object-cover bg-accent sm:size-24';

// The small thumbnail-beside-text layout every real search engine uses
// outside its dedicated Images/Videos tab -- a full-width media block makes
// sense when the user asked to see images/videos specifically, but clutters
// a mixed "All" list where most rows are plain text. Reuses the same
// resize/blurhash pipeline as the full MediaPreview (cached by URL, so
// switching tabs never re-fetches), just rendered small.
function CompactThumbnail({
  result,
  onOpen,
  blurNsfw = false,
}: {
  result: SearchResult;
  onOpen?: () => void;
  blurNsfw?: boolean;
}) {
  const isImage = result.kind === 'image';
  const isVideo = VIDEO_KINDS.has(result.kind);
  const placeholder = useBlurhashPlaceholder(result.blurhash);
  const resized = useResizedImage(isImage ? sanitizeHref(result.mediaUrl) : null);
  const [failed, setFailed] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const blurred = blurNsfw && shouldBlurMedia(result) && !revealed;

  let src: string | null = null;
  if (!failed) {
    if (isImage) {
      if (resized.status === 'ready' && resized.blobUrl) src = resized.blobUrl;
      else if (resized.status === 'error') src = sanitizeHref(result.mediaUrl);
      else src = placeholder;
    } else {
      // video/article/nsite thumbnails are a plain poster/cover image -- no
      // resize worker needed, they're not meant to be large to begin with.
      src = sanitizeHref(result.thumbnailUrl) ?? placeholder;
    }
  }
  const loading = !src && isImage && resized.status === 'loading';

  if (!src) {
    return (
      <div
        aria-hidden="true"
        className={`${COMPACT_THUMB_CLASS} flex flex-col items-center justify-center gap-1 text-muted-foreground ${
          loading ? 'animate-pulse' : ''
        }`}
      >
        {loading ? null : isVideo ? (
          <VideoIcon className="size-5" />
        ) : (
          <ImageIcon className="size-5" />
        )}
      </div>
    );
  }

  const alt = result.title || result.description || `${result.kind} thumbnail`;
  const thumb = (
    <div className="relative shrink-0 overflow-hidden rounded-md">
      <img
        src={src}
        alt={onOpen ? '' : alt}
        loading="lazy"
        decoding="async"
        onError={() => setFailed(true)}
        className={cn(COMPACT_THUMB_CLASS, blurred && 'scale-110 blur-lg')}
      />
      {isVideo && !blurred && (
        <span
          aria-hidden="true"
          className="absolute inset-0 flex items-center justify-center rounded-md bg-black/10"
        >
          <span className="flex size-6 items-center justify-center rounded-full bg-black/60">
            <Play className="size-3 fill-white text-white" />
          </span>
        </span>
      )}
      {blurred && (
        <span
          aria-hidden="true"
          className="absolute inset-0 flex flex-col items-center justify-center gap-1 bg-black/50 text-white"
        >
          <EyeOff className="size-4" aria-hidden="true" />
          <span className="max-w-[90%] truncate text-[9px] font-semibold tracking-wide uppercase">
            {result.contentWarning}
          </span>
        </span>
      )}
    </div>
  );

  // The first click on a blurred thumbnail reveals it; a second click keeps
  // its normal meaning (open the preview). Doing both at once would show the
  // media before the reader asked for it.
  if (blurred) {
    return (
      <button
        type="button"
        onClick={() => setRevealed(true)}
        aria-label={`Reveal media the publisher flagged as ${result.contentWarning}`}
        className="shrink-0 cursor-pointer rounded-md focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        {thumb}
      </button>
    );
  }

  if (!onOpen) return thumb;
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`Preview ${result.kind === 'image' ? 'image' : 'video'}`}
      className="shrink-0 cursor-pointer rounded-md focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
    >
      {thumb}
    </button>
  );
}

// Used for every result EXCEPT the Images/Videos tabs, which render
// MediaGridCard's grid instead -- see SearchPage.tsx. So an image/video
// result reaching this component only ever happens in "All" or one of the
// other mixed tabs, where it always gets the compact thumbnail treatment,
// never a full-size preview (that's what the dedicated grid is for).
export function ResultRow({
  result,
  isFollowed = false,
  blurNsfw = false,
}: {
  result: SearchResult;
  /** Whether the signed-in NIP-07 user follows this result's author -- see lib/ranking.ts. */
  isFollowed?: boolean;
  /** Blur publisher-flagged NSFW media until clicked -- see lib/nsfw.ts. */
  blurNsfw?: boolean;
}) {
  const author = useAuthor(result.pubkey);
  const displayName = author.data?.metadata?.name?.trim();
  const rawIdentity = result.nip05 ?? displayName ?? result.npub ?? result.pubkey;
  const identity = truncateIdentity(rawIdentity);

  const isMedia = MEDIA_KINDS.has(result.kind);
  // A compact thumbnail applies to any image/video result, plus
  // articles (NIP-23 `image` cover) and nsites (an extracted `og:image` --
  // see extract.js) when one was actually found. Most other kinds have no
  // thumbnail concept at all, and an nsite with no og:image just falls
  // through to the plain text row, same as always.
  const hasOptionalThumbnail =
    (result.kind === 'article'
      || result.kind === 'profile'
      || result.kind === 'event'
      || result.kind === 'live-stream'
      || result.kind.startsWith('nsite'))
    && !!result.thumbnailUrl;
  const useCompactThumbnail = isMedia || hasOptionalThumbnail;

  // An nsite's `endpoint` (the manifest's resolved entry path, e.g.
  // "/index.html" -- see store.js's upsertNsite) is never itself a usable
  // href, just a relative path with no host; link to the site's
  // `nsite://` address instead (see lib/sanitize.ts) and let ncc-browser's
  // own directory-index resolution pick the entry page, same as this
  // backend does for the crawl. Clicking an image/video result's title
  // opens the original file -- there's no separate "page" for it the way
  // there is for an ncc-service/nsite result.
  const href = result.kind.startsWith('nsite')
    ? nsiteHref(result.pubkey, result.npub, result.itemId)
    : (sanitizeHref(result.endpoint) ??
        (isMedia || result.kind === 'npack' ? sanitizeHref(result.mediaUrl) : null));
  const title = result.title?.trim() || identity;
  const body = result.snippet || result.description || '';
  const status = useResultStatus(result);
  const liveBadge = liveLabel(result);
  const schedule = scheduleLabel(result);
  // Deliberately per-row state: the dialog mounts closed and its article
  // query stays disabled until this is true (see ArticlePreviewDialog), so
  // rendering a page of results never fetches article bodies.
  const [previewOpen, setPreviewOpen] = useState(false);
  // Media results open a real in-page viewer instead of a popup. NCC Browser
  // may host this app where a `target="_blank"` has nowhere to open, which
  // made a click look like it did nothing.
  const [mediaOpen, setMediaOpen] = useState(false);
  const preview = mediaPreviewTarget(result);

  const openMediaPreview = (event: MouseEvent<HTMLAnchorElement>) => {
    if (!preview) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
    event.preventDefault();
    setMediaOpen(true);
  };

  const content = (
    <>
      {href ? (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer nofollow"
          onClick={openMediaPreview}
          aria-haspopup={preview ? 'dialog' : undefined}
          className="block truncate text-lg text-blue-700 hover:underline visited:text-purple-700 dark:text-blue-400 dark:visited:text-purple-400"
        >
          {title}
        </a>
      ) : (
        <h3 className="truncate text-lg font-medium text-foreground">{title}</h3>
      )}

      {/* Breadcrumb/meta line, now under the title -- identity, kind, reachability. */}
      <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 text-sm">
        <IdentityMark seed={result.pubkey} letter={identity.slice(0, 1).toUpperCase()} />
        <span className="truncate text-emerald-700 dark:text-emerald-400">{identity}</span>
        <span className="text-muted-foreground" aria-hidden="true">·</span>
        <span className="text-muted-foreground">{KIND_LABEL[result.kind]}</span>
        {liveBadge && (
          <>
            <span className="text-muted-foreground" aria-hidden="true">·</span>
            <span
              className={
                liveBadge.tone === 'live'
                  ? 'rounded-full bg-red-600 px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-white'
                  : 'text-xs text-muted-foreground'
              }
            >
              {liveBadge.text}
            </span>
          </>
        )}
        {isFollowed && (
          <>
            <span className="text-muted-foreground" aria-hidden="true">·</span>
            <span className="font-medium text-blue-700 dark:text-blue-400">following</span>
          </>
        )}
        {status && (
          <>
            <span className="text-muted-foreground" aria-hidden="true">·</span>
            <StatusDot status={status} />
          </>
        )}
        {/* The event's own posting date when the backend recorded one; the
            index time only as the fallback for rows that have no event date
            (profiles, NCC services) or predate the column. Saying which one
            is shown is the difference between "this is old" and "this was
            indexed a while ago", which readers reasonably confuse. */}
        {result.postedAt ? (
          <>
            <span className="text-muted-foreground" aria-hidden="true">·</span>
            <time
              dateTime={new Date(result.postedAt).toISOString()}
              title={`Posted ${new Date(result.postedAt).toLocaleString()}`}
              className="text-xs text-muted-foreground"
            >
              {new Date(result.postedAt).toLocaleDateString()}
            </time>
          </>
        ) : (
          result.indexedAt && (
            <>
              <span className="text-muted-foreground" aria-hidden="true">·</span>
              <time
                dateTime={new Date(result.indexedAt).toISOString()}
                title={`Indexed ${new Date(result.indexedAt).toLocaleString()}`}
                className="text-xs text-muted-foreground"
              >
                indexed {new Date(result.indexedAt).toLocaleDateString()}
              </time>
            </>
          )
        )}
        {schedule && (
          <>
            <span className="text-muted-foreground" aria-hidden="true">·</span>
            <span className="text-xs text-muted-foreground" title="Scheduled start">
              {result.kind === 'live-stream' ? 'starts' : 'event'} {schedule}
            </span>
          </>
        )}
        {result.location && (
          <>
            <span className="text-muted-foreground" aria-hidden="true">·</span>
            <span className="max-w-56 truncate text-xs text-muted-foreground" title={result.location}>
              {result.location}
            </span>
          </>
        )}
        {/* Only reachable with safe search off -- see SearchPage.tsx's
            `results` filter. Labels what the publisher tagged; this app
            makes no judgment of its own, see src/adapters/media.js. */}
        {result.contentWarning && (
          <>
            <span className="text-muted-foreground" aria-hidden="true">·</span>
            <span
              title={result.contentWarning}
              className="rounded-full bg-amber-100 px-1.5 py-0.5 text-xs font-medium text-amber-900 dark:bg-amber-900/40 dark:text-amber-300"
            >
              {result.contentWarning}
            </span>
          </>
        )}
      </div>

      {result.alternates && result.alternates.length > 0 && (
        <p className="mt-1 text-xs text-muted-foreground">
          Also published as{' '}
          {result.alternates.map((alt, i) => {
            const altHref = alt.kind.startsWith('nsite')
              ? nsiteHref(result.pubkey, result.npub, alt.itemId)
              : null;
            const label = alt.itemId === '_root' ? 'root site' : alt.itemId;
            return (
              <span key={alt.itemId}>
                {i > 0 && ', '}
                {altHref ? (
                  <a href={altHref} target="_blank" rel="noopener noreferrer nofollow" className="text-blue-700 hover:underline dark:text-blue-400">
                    {label}
                  </a>
                ) : (
                  label
                )}
              </span>
            );
          })}
        </p>
      )}

      {body && (
        <p className="mt-1 text-sm leading-snug text-foreground/80 [overflow-wrap:anywhere]">
          <Snippet text={body} />
        </p>
      )}

      {/* Articles have no external page to link a title to (a NIP-23 event's
          home is a relay coordinate, not a URL), so the title stays plain
          text and this is the row's one action: fetch the full event in the
          browser and render it. Nothing is loaded until it is clicked. */}
      {result.kind === 'article' && (
        <button
          type="button"
          onClick={() => setPreviewOpen(true)}
          aria-haspopup="dialog"
          className="mt-2 inline-flex items-center gap-1.5 rounded text-sm font-medium text-blue-700 hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none dark:text-blue-400"
        >
          <BookOpenText className="size-4" aria-hidden="true" />
          Preview article
        </button>
      )}

      {result.kind === 'article' && (
        <ArticlePreviewDialog result={result} open={previewOpen} onClose={() => setPreviewOpen(false)} />
      )}

      {preview && (
        <MediaPreviewDialog
          result={result}
          open={mediaOpen}
          onClose={() => setMediaOpen(false)}
          blurNsfw={blurNsfw}
        />
      )}
    </>
  );

  if (useCompactThumbnail) {
    return (
      <article className="flex max-w-2xl gap-3 py-5 first:pt-0">
        <CompactThumbnail
          result={result}
          onOpen={preview ? () => setMediaOpen(true) : undefined}
          blurNsfw={blurNsfw}
        />
        <div className="min-w-0 flex-1">{content}</div>
      </article>
    );
  }

  return <article className="max-w-2xl py-5 first:pt-0">{content}</article>;
}
