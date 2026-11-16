import type { SearchResult } from '@/lib/api';
import { sanitizeHref } from '@/lib/sanitize';

// The "Profiles" grid tab's card -- a people directory, not a thumbnail
// wall like MediaGridCard's image/video grid. A centered circular avatar
// reads as a person, not a photo to crop/fill the whole cell with, so this
// deliberately does NOT reuse MediaGridCard: that component's square,
// edge-to-edge image treatment is right for a photo but wrong for a face.
export function ProfileGridCard({
  result,
  isFollowed = false,
}: {
  result: SearchResult;
  isFollowed?: boolean;
}) {
  const identity = result.nip05 ?? result.npub ?? result.pubkey;
  const name = result.title?.trim() || identity;
  const avatar = sanitizeHref(result.thumbnailUrl);
  const href = sanitizeHref(result.endpoint);
  const initial = name.slice(0, 1).toUpperCase();

  const cell = (
    <div className="group relative flex aspect-square flex-col items-center justify-center gap-2 overflow-hidden rounded-md border border-border bg-accent px-3 py-4 text-center">
      {isFollowed && (
        <span className="absolute top-1.5 left-1.5 rounded-full bg-blue-700 px-1.5 py-0.5 text-[10px] font-medium text-white">
          following
        </span>
      )}

      {avatar ? (
        <img
          src={avatar}
          alt={name}
          loading="lazy"
          decoding="async"
          className="size-16 rounded-full border border-border object-cover transition-transform duration-150 group-hover:scale-105 sm:size-20"
        />
      ) : (
        <span
          aria-hidden="true"
          className="flex size-16 items-center justify-center rounded-full bg-muted text-lg font-semibold text-muted-foreground sm:size-20"
        >
          {initial}
        </span>
      )}

      <div className="min-w-0 max-w-full">
        <p className="truncate text-sm font-medium text-foreground">{name}</p>
        {identity !== name && (
          <p className="truncate text-xs text-emerald-700 dark:text-emerald-400">{identity}</p>
        )}
        {result.description && (
          <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{result.description}</p>
        )}
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
