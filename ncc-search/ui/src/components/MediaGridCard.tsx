import { Play } from 'lucide-react';
import type { SearchResult } from '@/lib/api';
import { useAuthor } from '@/hooks/useAuthor';
import { useResizedImage } from '@/hooks/useResizedImage';
import { useBlurhashPlaceholder } from '@/hooks/useBlurhashPlaceholder';
import { sanitizeHref } from '@/lib/sanitize';

// The grid of square thumbnails every real search engine uses for its
// dedicated Images/Videos tab -- see SearchPage.tsx, which renders this
// instead of ResultRow's text list only when that filter is active. A
// one-column list of full media players doesn't scale past a handful of
// results (confirmed live: 33+ stacked video players was a lot of
// scrolling); a grid is the actual point of a dedicated media tab.
//
// Deliberately no embedded <video> element: loading dozens of video
// elements at once in a grid is wasteful, and a grid cell isn't where
// playback belongs anyway (real search engines open the source on click
// too). Each cell is a static, clickable thumbnail; same resize/blurhash
// pipeline as the compact thumbnail (cached by URL, so switching between
// "All" and "Images" never re-fetches).
//
// No reachability status chip here, unlike ResultRow -- a grid of thumbnails
// reads cleanest with nothing but the image and a caption, same as Google
// Images/YouTube's own grids never show that kind of status per-cell.
export function MediaGridCard({
  result,
  isFollowed = false,
}: {
  result: SearchResult;
  isFollowed?: boolean;
}) {
  const author = useAuthor(result.pubkey);
  const isImage = result.kind === 'image';
  const placeholder = useBlurhashPlaceholder(result.blurhash);
  const resized = useResizedImage(isImage ? sanitizeHref(result.mediaUrl) : null);

  const href = sanitizeHref(result.mediaUrl);
  const displayName = author.data?.metadata?.name?.trim();
  const identity = result.nip05 ?? displayName ?? result.npub ?? result.pubkey;
  const title = result.title?.trim() || identity;

  let src: string | null;
  if (isImage) {
    if (resized.status === 'ready' && resized.blobUrl) src = resized.blobUrl;
    else if (resized.status === 'error') src = href;
    else src = placeholder;
  } else {
    src = sanitizeHref(result.thumbnailUrl) ?? placeholder;
  }

  const cell = (
    <div className="group relative aspect-square overflow-hidden rounded-md border border-border bg-accent">
      {src ? (
        <img
          src={src}
          alt={title}
          loading="lazy"
          decoding="async"
          className="size-full object-cover transition-transform duration-150 group-hover:scale-105"
        />
      ) : (
        <div aria-hidden="true" className="size-full animate-pulse" />
      )}

      {result.kind === 'video' && (
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
        <p className="truncate text-[10px] text-white/75">{identity}</p>
      </div>
    </div>
  );

  if (!href) return cell;
  return (
    <a href={href} target="_blank" rel="noopener noreferrer nofollow" className="block">
      {cell}
    </a>
  );
}
