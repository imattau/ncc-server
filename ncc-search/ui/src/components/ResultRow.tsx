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

const PREVIEW_CLASS = 'mt-2 max-h-80 rounded-md border border-border object-contain';

// Three-tier display while the real image loads, cheapest-first:
//   1. blurhash placeholder (instant, decoded on the main thread -- see
//      useBlurhashPlaceholder; a handful of pixels, not worth a worker)
//   2. the worker-resized, re-encoded (smaller) image, once ready
//   3. the original full-size URL directly, if resizing fails for any
//      reason (no CORS on the host, network error, unsupported browser) --
//      this is a fallback, not a requirement: every image stays viewable
//      even when the optimization can't apply.
// Never shows nothing: a plain skeleton box fills the gap before the first
// of these is available.
function ImagePreview({ result, mediaSrc }: { result: SearchResult; mediaSrc: string }) {
  const placeholder = useBlurhashPlaceholder(result.blurhash);
  const resized = useResizedImage(mediaSrc);
  const alt = result.description || result.title || 'image preview';

  if (resized.status === 'ready' && resized.blobUrl) {
    return <img src={resized.blobUrl} alt={alt} loading="lazy" decoding="async" className={PREVIEW_CLASS} />;
  }
  if (resized.status === 'error') {
    return <img src={mediaSrc} alt={alt} loading="lazy" decoding="async" className={PREVIEW_CLASS} />;
  }
  if (placeholder) {
    return (
      <img
        src={placeholder}
        alt={alt}
        aria-busy="true"
        className={`${PREVIEW_CLASS} blur-sm`}
        style={{ maxWidth: 320 }}
      />
    );
  }
  return (
    <div
      aria-hidden="true"
      className="mt-2 h-40 w-full max-w-sm animate-pulse rounded-md border border-border bg-accent"
    />
  );
}

function VideoPreview({ result, mediaSrc }: { result: SearchResult; mediaSrc: string }) {
  const posterSrc = sanitizeHref(result.thumbnailUrl);
  const placeholder = useBlurhashPlaceholder(result.blurhash);

  return (
    <video
      controls
      preload="metadata"
      poster={posterSrc ?? placeholder ?? undefined}
      className="mt-2 max-h-80 w-full max-w-md rounded-md border border-border"
    >
      <source src={mediaSrc} type={result.mediaType ?? undefined} />
    </video>
  );
}

// Only rendered once sanitizeHref approves the URL's scheme (http/https) --
// same rule as the title link, applied to a src/poster this time instead of
// an href. The browser fetches/decodes the media directly from its
// original host either way, never proxied through this UI's backend.
function MediaPreview({ result }: { result: SearchResult }) {
  const mediaSrc = sanitizeHref(result.mediaUrl);
  if (!mediaSrc) return null;
  return result.kind === 'image' ? (
    <ImagePreview result={result} mediaSrc={mediaSrc} />
  ) : (
    <VideoPreview result={result} mediaSrc={mediaSrc} />
  );
}

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
  // Clicking an image/video result's title opens the original file --
  // there's no separate "page" for it the way there is for an
  // ncc-service/nsite result.
  const href = sanitizeHref(result.endpoint) ?? (isMedia ? sanitizeHref(result.mediaUrl) : null);
  const title = result.title?.trim() || identity;
  const body = result.snippet || result.description || '';
  const status = useResultStatus(result);

  return (
    <article className="max-w-2xl py-5 first:pt-0">
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

      {isMedia && <MediaPreview result={result} />}

      {body && (
        <p className="mt-1 text-sm leading-snug text-foreground/80">
          <Snippet text={body} />
        </p>
      )}
    </article>
  );
}
