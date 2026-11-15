// Fetches the full-size image, decodes and downscales it off the main
// thread, and hands back a smaller re-encoded blob -- this is the "can the
// worker compress anything" answer: it can't reduce the bytes the origin
// server sends (this backend never runs a resize proxy -- see
// ../../src/adapters/media.js), but it CAN avoid ever handing the full-size
// bytes to the main thread's decoder/paint pipeline, and it can produce a
// genuinely smaller re-encoded file for display.
//
// Requires the media host to allow a cross-origin read (`mode: 'cors'`):
// most Blossom/CDN hosts serving public images do, but not all. When it
// doesn't -- or OffscreenCanvas/createImageBitmap aren't available, or
// anything else in this pipeline throws -- this reports failure and the
// caller (useResizedImage) falls back to rendering the original `mediaUrl`
// directly, exactly as this project did before this worker existed. That
// fallback is the point: this is a best-effort optimization, never a
// requirement for a result to be viewable.

export interface ResizeRequest {
  id: string;
  url: string;
  maxWidth?: number;
  maxHeight?: number;
}

export interface ResizeResult {
  id: string;
  success: boolean;
  blob?: Blob;
}

const DEFAULT_MAX_WIDTH = 720;
const DEFAULT_MAX_HEIGHT = 480;

self.onmessage = async (event: MessageEvent<ResizeRequest>) => {
  const { id, url, maxWidth = DEFAULT_MAX_WIDTH, maxHeight = DEFAULT_MAX_HEIGHT } = event.data;

  try {
    const response = await fetch(url, { mode: 'cors', cache: 'force-cache' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const sourceBlob = await response.blob();
    const bitmap = await createImageBitmap(sourceBlob);

    // Never upscale -- a source already smaller than the cap is left alone.
    const scale = Math.min(1, maxWidth / bitmap.width, maxHeight / bitmap.height);
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));

    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D context unavailable');
    ctx.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();

    const resizedBlob = await canvas.convertToBlob({ type: 'image/webp', quality: 0.82 });
    const result: ResizeResult = { id, success: true, blob: resizedBlob };
    (self as unknown as Worker).postMessage(result);
  } catch {
    const result: ResizeResult = { id, success: false };
    (self as unknown as Worker).postMessage(result);
  }
};
