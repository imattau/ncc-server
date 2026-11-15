import { Play } from 'lucide-react';
import type { ResultKind, SearchResult } from '@/lib/api';
import { useAuthor } from '@/hooks/useAuthor';
import { useMediaProbe } from '@/hooks/useMediaProbe';
import { useResizedImage } from '@/hooks/useResizedImage';
import { useBlurhashPlaceholder } from '@/hooks/useBlurhashPlaceholder';
import { sanitizeHref } from '@/lib/sanitize';
import { Snippet } from '@/components/Snippet';

const KIND_LABEL: Record<ResultKind, string> = {
  'ncc-service': 'NCC service',
  'nsite-root': 'nsite',
  'nsite-named': 'nsite',
  article: 'article',
  image: 'image',
  video: 'video',
};

const MEDIA_KINDS = new Set<ResultKind>(['image', 'video']);

// A full npub/hex pubkey (~63/64 chars) is too long for a one-line
// breadcrumb -- noticed this rendering a demo result with no profile and no
// nip05, where the full npub pushed everything else off-screen.
function truncateIdentity(value: string) {
  return value.length > 24 ? `${value.slice(0, 16)}…${value.slice(-6)}` : value;
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
function CompactThumbnail({ result }: { result: SearchResult }) {
  const isImage = result.kind === 'image';
  const placeholder = useBlurhashPlaceholder(result.blurhash);
  const resized = useResizedImage(isImage ? sanitizeHref(result.mediaUrl) : null);

  let src: string | null;
  if (isImage) {
    if (resized.status === 'ready' && resized.blobUrl) src = resized.blobUrl;
    else if (resized.status === 'error') src = sanitizeHref(result.mediaUrl);
    else src = placeholder;
  } else {
    // video and article thumbnails are a plain poster/cover image -- no
    // resize worker needed, they're not meant to be large to begin with.
    src = sanitizeHref(result.thumbnailUrl) ?? placeholder;
  }

  if (!src) {
    return <div aria-hidden="true" className={`${COMPACT_THUMB_CLASS} animate-pulse`} />;
  }

  const alt = result.title || result.description || `${result.kind} thumbnail`;
  return (
    <div className="relative shrink-0">
      <img src={src} alt={alt} loading="lazy" decoding="async" className={COMPACT_THUMB_CLASS} />
      {result.kind === 'video' && (
        <span
          aria-hidden="true"
          className="absolute inset-0 flex items-center justify-center rounded-md bg-black/10"
        >
          <span className="flex size-6 items-center justify-center rounded-full bg-black/60">
            <Play className="size-3 fill-white text-white" />
          </span>
        </span>
      )}
    </div>
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
}: {
  result: SearchResult;
  /** Whether the signed-in NIP-07 user follows this result's author -- see lib/ranking.ts. */
  isFollowed?: boolean;
}) {
  const author = useAuthor(result.pubkey);
  const displayName = author.data?.metadata?.name?.trim();
  const rawIdentity = result.nip05 ?? displayName ?? result.npub ?? result.pubkey;
  const identity = truncateIdentity(rawIdentity);

  const isMedia = MEDIA_KINDS.has(result.kind);
  // A compact thumbnail applies to any image/video result, plus articles
  // that carry a NIP-23 `image` cover.
  const useCompactThumbnail = isMedia || (result.kind === 'article' && !!result.thumbnailUrl);

  // Clicking an image/video result's title opens the original file --
  // there's no separate "page" for it the way there is for an
  // ncc-service/nsite result.
  const href = sanitizeHref(result.endpoint) ?? (isMedia ? sanitizeHref(result.mediaUrl) : null);
  const title = result.title?.trim() || identity;
  const body = result.snippet || result.description || '';
  const status = useResultStatus(result);

  const content = (
    <>
      {href ? (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer nofollow"
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
      </div>

      {body && (
        <p className="mt-1 text-sm leading-snug text-foreground/80">
          <Snippet text={body} />
        </p>
      )}
    </>
  );

  if (useCompactThumbnail) {
    return (
      <article className="flex max-w-2xl gap-3 py-5 first:pt-0">
        <CompactThumbnail result={result} />
        <div className="min-w-0 flex-1">{content}</div>
      </article>
    );
  }

  return <article className="max-w-2xl py-5 first:pt-0">{content}</article>;
}
