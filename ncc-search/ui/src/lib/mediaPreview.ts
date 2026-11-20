import type { ResultKind, SearchResult } from '@/lib/api';
import { sanitizeHref } from '@/lib/sanitize';

// The in-app preview target for a media result.
//
// Results pages used to make the card itself a `target="_blank"` link to the
// raw media file. That works in a normal browser, but in NCC Browser the
// search app runs inside a WebContentsView (or, on Android, an iframe), where
// a popup it cannot create leaves the click with no visible result. A
// thumbnail-less video makes that worse: the card is an anonymous grey square,
// so "nothing happened" is indistinguishable from "there was no preview".
//
// Every media result therefore opens a real in-page dialog first. It needs no
// popup, shows the file itself even when no poster was published, and still
// offers the original URL for anyone who wants the raw file.
export const MEDIA_PREVIEW_KINDS = new Set<ResultKind>(['image', 'video', 'short-video']);

export interface MediaPreviewTarget {
  kind: 'image' | 'video';
  /** The original media URL, already validated as http(s). */
  src: string;
  /** A poster image for videos, when the publisher supplied one. */
  poster: string | null;
}

/**
 * The preview for a media result, or null when it has no usable media URL
 * (a live NIP-50 hit before the crawler indexed it, for example).
 */
export function mediaPreviewTarget(
  result: Pick<SearchResult, 'kind' | 'mediaUrl' | 'thumbnailUrl'>,
): MediaPreviewTarget | null {
  if (!MEDIA_PREVIEW_KINDS.has(result.kind)) return null;
  const src = sanitizeHref(result.mediaUrl);
  if (!src) return null;
  return {
    kind: result.kind === 'image' ? 'image' : 'video',
    src,
    poster: result.kind === 'image' ? null : sanitizeHref(result.thumbnailUrl),
  };
}
