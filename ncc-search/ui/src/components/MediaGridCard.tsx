import { useState, type MouseEvent } from 'react';
import { createPortal } from 'react-dom';
import { Play, Image as ImageIcon, Video as VideoIcon } from 'lucide-react';
import type { SearchResult } from '@/lib/api';
import { useAuthor } from '@/hooks/useAuthor';
import { useResizedImage } from '@/hooks/useResizedImage';
import { useBlurhashPlaceholder } from '@/hooks/useBlurhashPlaceholder';
import { mediaPreviewTarget } from '@/lib/mediaPreview';
import { sanitizeHref } from '@/lib/sanitize';
import { MediaPreviewDialog } from '@/components/MediaPreviewDialog';

// The grid of square thumbnails every real search engine uses for its
// dedicated Images/Videos tab -- see SearchPage.tsx, which renders this
// instead of ResultRow's text list only when that filter is active. A
// one-column list of full media players doesn't scale past a handful of
// results (confirmed live: 33+ stacked video players was a lot of
// scrolling); a grid is the actual point of a dedicated media tab.
//
// Deliberately no embedded <video> element in the cell: loading dozens of
// video elements at once in a grid is wasteful. Playback belongs in
// MediaPreviewDialog, which opens on click and needs no popup -- NCC
// Browser may host this app where `target="_blank"` has nowhere to go.
//
// A result without a poster is an honest empty tile with an icon and a
// label, not an endless pulsing skeleton: "no preview exists" and "still
// loading" must not look the same. The pulsing state is only used while an
// image resize is genuinely in flight.
export function MediaGridCard({
  result,
  isFollowed = false,
}: {
  result: SearchResult;
  isFollowed?: boolean;
}) {
  const author = useAuthor(result.pubkey);
  const isImage = result.kind === 'image';
  const isVideo = result.kind === 'video' || result.kind === 'short-video';
  const placeholder = useBlurhashPlaceholder(result.blurhash);
  const resized = useResizedImage(isImage ? sanitizeHref(result.mediaUrl) : null);
  const preview = mediaPreviewTarget(result);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [imageFailed, setImageFailed] = useState(false);

  const href = sanitizeHref(result.mediaUrl);
  const displayName = author.data?.metadata?.name?.trim();
  const identity = result.nip05 ?? displayName ?? result.npub ?? result.pubkey;
  const title = result.title?.trim() || identity;
  const indexedLabel = result.indexedAt ? new Date(result.indexedAt).toLocaleDateString() : null;

  let src: string | null = null;
  if (!imageFailed) {
    if (isImage) {
      if (resized.status === 'ready' && resized.blobUrl) src = resized.blobUrl;
      else if (resized.status === 'error') src = href;
      else src = placeholder;
    } else {
      src = sanitizeHref(result.thumbnailUrl) ?? placeholder;
    }
  }
  const loading = !src && isImage && resized.status === 'loading';

  const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (!preview) return;
    // Leave modified and middle clicks to the browser: those are deliberate
    // "open the raw file" gestures.
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
    event.preventDefault();
    setPreviewOpen(true);
  };

  const cell = (
    <div className="group relative aspect-square overflow-hidden rounded-md border border-border bg-accent">
      {src ? (
        <img
          src={src}
          alt={title}
          loading="lazy"
          decoding="async"
          onError={() => setImageFailed(true)}
          className="size-full object-cover transition-transform duration-150 group-hover:scale-105"
        />
      ) : loading ? (
        <div aria-hidden="true" className="size-full animate-pulse" />
      ) : (
        <div className="flex size-full flex-col items-center justify-center gap-1.5 px-2 text-muted-foreground">
          {isVideo ? (
            <VideoIcon className="size-6" aria-hidden="true" />
          ) : (
            <ImageIcon className="size-6" aria-hidden="true" />
          )}
          <span className="text-center text-[10px] leading-tight font-medium">
            {preview || href ? 'No preview' : 'Not indexed yet'}
          </span>
        </div>
      )}

      {isVideo && src && (
        <span
          aria-hidden="true"
          className="absolute inset-0 flex items-center justify-center bg-black/10"
        >
          <span className="flex size-9 items-center justify-center rounded-full bg-black/60">
            <Play className="size-4 fill-white text-white" />
          </span>
        </span>
      )}

      {isFollowed && (
        <span className="absolute top-1.5 left-1.5 rounded-full bg-blue-700 px-1.5 py-0.5 text-[10px] font-medium text-white">
          following
        </span>
      )}

      {/* Only reachable with safe search off, which is the only way this
          card renders at all here -- see SearchPage.tsx's `results` filter.
          Labels what the publisher tagged; this app makes no judgment of
          its own, see src/adapters/media.js. */}
      {result.contentWarning && (
        <span
          title={result.contentWarning}
          className="absolute top-1.5 right-1.5 rounded-full bg-black/70 px-1.5 py-0.5 text-[10px] font-medium text-white"
        >
          {result.contentWarning}
        </span>
      )}

      <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent px-2 pt-6 pb-1.5">
        <p className="truncate text-xs font-medium text-white">{title}</p>
        <p className="truncate text-[10px] text-white/75">
          {identity}{indexedLabel ? ` · indexed ${indexedLabel}` : ''}
        </p>
      </div>
    </div>
  );

  if (!href) return cell;
  return (
    <>
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer nofollow"
        className="block"
        onClick={handleClick}
        aria-haspopup={preview ? 'dialog' : undefined}
      >
        {cell}
      </a>
      {preview && createPortal(
        <MediaPreviewDialog
          result={result}
          open={previewOpen}
          onClose={() => setPreviewOpen(false)}
        />,
        document.body,
      )}
    </>
  );
}
