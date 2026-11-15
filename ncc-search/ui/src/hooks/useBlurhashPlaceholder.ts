import { useMemo } from 'react';
import { decode } from 'blurhash';

// Deliberately NOT in a Web Worker: decoding a blurhash at this size is a
// handful of pixels (default 32x32) and finishes in well under a
// millisecond -- routing it through a worker would add message-passing
// overhead for no measurable benefit. The genuinely expensive step (fetch +
// decode + resize a full-size image) is what useResizedImage's worker is
// for; this is just a cheap synchronous decode, same category of cost as
// parsing the search result JSON itself.
//
// `blurhash` comes straight from a NIP-68/71 relay event, so it is
// untrusted: a malformed string (wrong length, bad characters) makes
// `decode()` throw. That must not take the result row down with it.

/** @returns a data: URL for the decoded placeholder, or null if there's no hash or it's invalid */
export function useBlurhashPlaceholder(
  hash: string | null | undefined,
  width = 32,
  height = 32,
): string | null {
  return useMemo(() => {
    if (!hash) return null;
    try {
      const pixels = decode(hash, width, height);
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      const imageData = ctx.createImageData(width, height);
      imageData.data.set(pixels);
      ctx.putImageData(imageData, 0, 0);
      return canvas.toDataURL();
    } catch {
      return null;
    }
  }, [hash, width, height]);
}
