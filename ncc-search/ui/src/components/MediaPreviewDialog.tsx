import { useEffect, useId, useRef, useState } from 'react';
import { ExternalLink, ImageIcon, Play, X } from 'lucide-react';

import type { SearchResult } from '@/lib/api';
import { useAuthor } from '@/hooks/useAuthor';
import { mediaPreviewTarget } from '@/lib/mediaPreview';
import { sanitizeHref } from '@/lib/sanitize';
import { truncateIdentity } from '@/lib/identity';

const ACTION_LINK_CLASS =
  'inline-flex items-center gap-1 text-sm font-medium text-blue-700 hover:underline dark:text-blue-400';

// An in-page viewer for image/video results.
//
// Search results used to be `target="_blank"` links to the raw file. That is
// fine in a desktop browser, but NCC Browser hosts this app in a tab or an
// iframe where a popup may not open at all, so a click on a result could
// visibly do nothing -- worst of all for a poster-less video, which is just a
// grey tile. This dialog needs no popup: it shows the media (or a named
// failure) right here, and keeps the original URL one click away.
//
// Kept mounted but inert until `open` is true, same pattern as
// ArticlePreviewDialog: rendering a page of results costs nothing.
export function MediaPreviewDialog({
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
  const author = useAuthor(open ? result.pubkey : undefined);
  const [failed, setFailed] = useState(false);

  const target = mediaPreviewTarget(result);
  const displayName = author.data?.metadata?.name?.trim();
  const identity = truncateIdentity(result.nip05 ?? displayName ?? result.npub ?? result.pubkey);
  const title = result.title?.trim() || identity;
  const original = sanitizeHref(result.mediaUrl);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && open && !dialog.open) dialog.showModal();
    if (dialog && !open && dialog.open) dialog.close();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    setFailed(false);
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open, result.itemId]);

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      className="m-auto max-h-[90dvh] w-[min(94vw,72rem)] overflow-hidden rounded-xl border border-border bg-background p-0 text-foreground shadow-2xl backdrop:bg-black/70 max-sm:m-0 max-sm:h-dvh max-sm:max-h-none max-sm:w-full max-sm:max-w-none max-sm:rounded-none max-sm:border-0 pointer-coarse:m-0 pointer-coarse:h-dvh pointer-coarse:max-h-none pointer-coarse:w-full pointer-coarse:max-w-none pointer-coarse:rounded-none pointer-coarse:border-0"
    >
      <div className="flex max-h-[90dvh] flex-col max-sm:h-dvh max-sm:max-h-none pointer-coarse:h-dvh pointer-coarse:max-h-none">
        <header className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-2.5 sm:px-5">
          {target?.kind === 'video' ? (
            <Play className="size-4 text-muted-foreground" aria-hidden="true" />
          ) : (
            <ImageIcon className="size-4 text-muted-foreground" aria-hidden="true" />
          )}
          <span className="min-w-0 truncate text-sm font-medium text-muted-foreground">
            {target?.kind === 'video' ? 'Video preview' : 'Image preview'}
          </span>
          <div className="ml-auto flex items-center gap-3">
            {original && (
              <a
                href={original}
                target="_blank"
                rel="noopener noreferrer nofollow"
                aria-label="Open the original file"
                className={ACTION_LINK_CLASS}
              >
                <ExternalLink className="size-3.5" aria-hidden="true" />
                <span className="sm:hidden">Original</span>
                <span className="hidden sm:inline">Open original</span>
              </a>
            )}
            <button
              type="button"
              onClick={onClose}
              aria-label="Close media preview"
              className="rounded p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            >
              <X className="size-4" aria-hidden="true" />
            </button>
          </div>
        </header>

        <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-black/90 p-2 sm:p-4">
          {!target ? (
            <p className="max-w-md px-6 py-10 text-center text-sm text-white/80">
              This result has no media file yet. It may still be indexing — try again in a
              moment, or search for its author.
            </p>
          ) : failed ? (
            <div className="max-w-md px-6 py-10 text-center text-white/80">
              <p className="text-sm">
                This {target.kind} could not be shown here. The browser may not support its
                format, or the host may have blocked it.
              </p>
              {original && (
                <a
                  href={original}
                  target="_blank"
                  rel="noopener noreferrer nofollow"
                  className="mt-3 inline-flex items-center gap-1 text-sm font-medium text-blue-300 hover:underline"
                >
                  <ExternalLink className="size-3.5" aria-hidden="true" /> Open original
                </a>
              )}
            </div>
          ) : target.kind === 'image' ? (
            <img
              src={target.src}
              alt={title}
              decoding="async"
              referrerPolicy="no-referrer"
              onError={() => setFailed(true)}
              className="max-h-[calc(90dvh-8rem)] max-w-full object-contain"
            />
          ) : (
            <video
              src={target.src}
              poster={target.poster ?? undefined}
              controls
              autoPlay
              playsInline
              preload="metadata"
              onError={() => setFailed(true)}
              className="max-h-[calc(90dvh-8rem)] w-full max-w-full bg-black"
            >
              Your browser cannot play this video.
            </video>
          )}
        </div>

        <footer className="shrink-0 border-t border-border px-4 py-3 sm:px-5">
          <h1
            id={titleId}
            className="truncate text-base leading-tight font-semibold text-foreground"
          >
            {title}
          </h1>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
            <span className="truncate text-emerald-700 dark:text-emerald-400">{identity}</span>
            <span aria-hidden="true">·</span>
            <span>{result.kind === 'image' ? 'image' : 'video'}</span>
          </p>
        </footer>
      </div>
    </dialog>
  );
}
