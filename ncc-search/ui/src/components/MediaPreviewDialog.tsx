import { useEffect, useId, useRef, useState } from 'react';
import { ExternalLink, EyeOff, ImageIcon, Play, X } from 'lucide-react';

import type { SearchResult } from '@/lib/api';
import { useAuthor } from '@/hooks/useAuthor';
import { mediaPreviewTarget } from '@/lib/mediaPreview';
import { shouldBlurMedia } from '@/lib/nsfw';
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
// The dialog element stays mounted but inert until `open` is true, same
// pattern as ArticlePreviewDialog: rendering a page of results costs nothing.
// The media itself is *not* inert, though: a mounted `<video src autoPlay>`
// keeps playing when its `<dialog>` is merely hidden with `close()`, and
// Android WebView allows that autoplay without a gesture
// (`mediaPlaybackRequiresUserGesture = false` in NCC Browser). So the
// `<img>`/`<video>` only exists while `open`, and closing it explicitly
// pauses and releases the element -- see the effect below.
export function MediaPreviewDialog({
  result,
  open,
  onClose,
  blurNsfw = false,
}: {
  result: SearchResult;
  open: boolean;
  onClose: () => void;
  /** Blur publisher-flagged NSFW media until revealed -- see lib/nsfw.ts. */
  blurNsfw?: boolean;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const titleId = useId();
  const author = useAuthor(open ? result.pubkey : undefined);
  const [failed, setFailed] = useState(false);
  // Deliberately not shared with the card that opened this dialog: the grid
  // tile's reveal is a thumbnail-sized decision, while this is the full-size
  // file. Closing the dialog resets it (see the effect below).
  const [revealed, setRevealed] = useState(false);

  const target = mediaPreviewTarget(result);
  const displayName = author.data?.metadata?.name?.trim();
  const identity = truncateIdentity(result.nip05 ?? displayName ?? result.npub ?? result.pubkey);
  const title = result.title?.trim() || identity;
  const original = sanitizeHref(result.mediaUrl);
  // A blurred video must not be mounted at all: Android WebView allows
  // autoplay without a gesture, so a merely CSS-blurred player would still
  // play audio. Only an image/poster is safe to show behind the veil.
  const poster = sanitizeHref(result.thumbnailUrl);
  const blurred = blurNsfw && shouldBlurMedia(result) && !revealed;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && open && !dialog.open) dialog.showModal();
    if (dialog && !open && dialog.open) dialog.close();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    setFailed(false);
    setRevealed(false);
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open, result.itemId]);

  // Android WebView does not reliably stop a <video> when its dialog is
  // hidden or removed: the audio can outlive the view that owns it, which is
  // how a preview used to keep playing after it was closed, and even after
  // leaving nccsearch. Pausing on hide, and tearing the source down on close,
  // makes the stop explicit instead of leaving it to the renderer. The
  // element is captured here rather than read from the ref in the cleanup:
  // by the time a passive cleanup runs, React may already have detached it,
  // but pause()/load() still work on a detached media element.
  useEffect(() => {
    if (!open) return;
    const video = videoRef.current;
    const pause = () => {
      try {
        video?.pause();
      } catch {
        // A torn-down element can throw; nothing is left to stop.
      }
    };
    const onVisibilityChange = () => {
      if (document.hidden) pause();
    };
    const release = () => {
      if (!video) return;
      try {
        video.pause();
        video.removeAttribute('src');
        video.load();
      } catch {
        // Same as above: the media element is already gone.
      }
    };
    // pagehide covers an iframe being unloaded (NCC Browser's Android shell
    // does that when its nccsearch panel closes); visibilitychange covers the
    // app being backgrounded while the document itself survives.
    window.addEventListener('pagehide', pause);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      window.removeEventListener('pagehide', pause);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      release();
    };
    // `failed` and the source are dependencies because either one decides
    // whether the <video> actually exists: re-running here is what captures
    // a player that mounts one render after `open` (the error flag is reset
    // in the effect above), and what releases one that unmounts on error.
    // `blurred` is here for the same reason: revealing a held-back NSFW
    // video is what mounts the element in the first place, so the cleanup
    // must be re-captured after that transition or closing the dialog
    // could leave its audio playing.
  }, [open, failed, target?.src, blurred]);

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
          {!open ? null : !target ? (
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
          ) : blurred ? (
            <div className="relative flex min-h-[18rem] max-h-[calc(90dvh-8rem)] w-full items-center justify-center overflow-hidden">
              {poster && (
                <img
                  src={poster}
                  alt=""
                  aria-hidden="true"
                  decoding="async"
                  referrerPolicy="no-referrer"
                  className="max-h-[calc(90dvh-8rem)] max-w-full scale-110 object-contain blur-2xl"
                />
              )}
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/50 px-6 py-10 text-center">
                <EyeOff className="size-8 text-white/80" aria-hidden="true" />
                <p className="max-w-md text-sm text-white/85">
                  The publisher flagged this {target.kind} as &ldquo;{result.contentWarning}&rdquo;.
                </p>
                <button
                  type="button"
                  onClick={() => setRevealed(true)}
                  className="rounded-md bg-white px-3 py-1.5 text-sm font-medium text-black hover:bg-white/90 focus-visible:ring-2 focus-visible:ring-white focus-visible:outline-none"
                >
                  Show anyway
                </button>
              </div>
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
              ref={videoRef}
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
