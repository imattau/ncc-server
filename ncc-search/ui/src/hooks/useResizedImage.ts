import { useEffect, useState } from 'react';
import type { ResizeRequest, ResizeResult } from '@/workers/imageResize.worker';

export type ResizeStatus = 'loading' | 'ready' | 'error';
export interface ResizeState {
  status: ResizeStatus;
  blobUrl: string | null;
}

// One shared worker for the whole page, same pattern as useMediaProbe --
// cheap, I/O-bound-then-CPU-bound work, no need for one worker per result.
// Results cache by URL at module scope so switching filter tabs or
// re-rendering never re-fetches/re-resizes an image this page already
// processed.
let worker: Worker | null = null;
const cache = new Map<string, ResizeState>();
const listeners = new Map<string, Set<() => void>>();
const idToUrl = new Map<string, string>();
let nextId = 0;

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL('../workers/imageResize.worker.ts', import.meta.url), {
      type: 'module',
    });
    worker.onmessage = (event: MessageEvent<ResizeResult>) => {
      const { id, success, blob } = event.data;
      const url = idToUrl.get(id);
      idToUrl.delete(id);
      if (!url) return;

      const next: ResizeState = success && blob
        ? { status: 'ready', blobUrl: URL.createObjectURL(blob) }
        : { status: 'error', blobUrl: null };
      cache.set(url, next);
      listeners.get(url)?.forEach((notify) => notify());
    };
  }
  return worker;
}

/**
 * Attempts to fetch and downscale an image off the main thread. On success,
 * `blobUrl` is a smaller re-encoded object URL to render instead of the
 * original. On `status: 'error'` (CORS rejection, network failure, decode
 * failure, or an unsupported browser), the caller should fall back to
 * rendering `mediaUrl` directly -- this is a best-effort optimization, never
 * the only way to view a result.
 */
export function useResizedImage(url: string | null | undefined): ResizeState {
  const [, forceRender] = useState(0);

  useEffect(() => {
    if (!url) return;

    if (!cache.has(url)) {
      cache.set(url, { status: 'loading', blobUrl: null });
      const id = String(nextId++);
      idToUrl.set(id, url);
      const request: ResizeRequest = { id, url };
      getWorker().postMessage(request);
    }

    let set = listeners.get(url);
    if (!set) {
      set = new Set();
      listeners.set(url, set);
    }
    const notify = () => forceRender((n) => n + 1);
    set.add(notify);

    return () => {
      listeners.get(url)?.delete(notify);
    };
  }, [url]);

  if (!url) return { status: 'loading', blobUrl: null };
  return cache.get(url) ?? { status: 'loading', blobUrl: null };
}
