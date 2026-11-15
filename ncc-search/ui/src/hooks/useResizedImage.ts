import { useEffect, useState } from 'react';
import type { ResizeRequest, ResizeResult } from '@/workers/imageResize.worker';

export type ResizeStatus = 'loading' | 'ready' | 'error';
export interface ResizeState {
  status: ResizeStatus;
  blobUrl: string | null;
}

interface CacheEntry extends ResizeState {
  byteSize: number;
}

// This cache holds real decoded-image memory (each `blobUrl` is a live
// `createObjectURL` reference keeping its Blob alive) for as long as the
// page stays open, across every result ever resized this session -- left
// unbounded, a long scrolling/searching session could hold onto an
// arbitrarily large amount of resized-image memory. Capped by total bytes
// (the resize worker reports each blob's real size, not just a row count,
// since image sizes vary wildly) with LRU eviction: the least-recently
// *read* entry is dropped first, tracked by `lruOrder`'s insertion order,
// re-touched on every cache hit.
//
// Operator-configurable, same convention as VITE_NCC_SEARCH_API_BASE --
// this is a build-time site setting, not a live end-user control, since
// there's no settings surface in this app for an end user to turn a dial
// on. Defaults to 150MB, picked as "generous enough that a normal search
// session never hits it, small enough that a page left open overnight
// scrolling through images doesn't quietly eat a gigabyte of RAM".
const MAX_CACHE_BYTES = Number(import.meta.env.VITE_NCC_SEARCH_IMAGE_CACHE_MAX_BYTES) || 150 * 1024 * 1024;

let worker: Worker | null = null;
const cache = new Map<string, CacheEntry>();
// A Map used purely for its insertion-order iteration: re-`set`ting an
// existing key moves it to the end, so the first key in iteration order is
// always the least-recently-touched one -- a textbook LRU without pulling
// in a dependency for it.
const lruOrder = new Map<string, true>();
let totalBytes = 0;
const listeners = new Map<string, Set<() => void>>();
const idToUrl = new Map<string, string>();
let nextId = 0;

function touch(url: string) {
  lruOrder.delete(url);
  lruOrder.set(url, true);
}

function evict(url: string) {
  const entry = cache.get(url);
  if (!entry) return;
  if (entry.blobUrl) URL.revokeObjectURL(entry.blobUrl);
  totalBytes -= entry.byteSize;
  cache.delete(url);
  lruOrder.delete(url);
  // No `notify()` here: evicting always skips URLs with active listeners
  // (see setEntry below), so nothing currently mounted is watching this
  // entry anyway -- a stale notify would be a no-op at best.
}

function setEntry(url: string, entry: CacheEntry) {
  const previous = cache.get(url);
  if (previous) totalBytes -= previous.byteSize;
  cache.set(url, entry);
  totalBytes += entry.byteSize;
  touch(url);

  // Evict the least-recently-touched entries first, skipping any URL a
  // component currently has mounted (an active listener) -- revoking a
  // blob URL still being rendered would break that `<img>` with no retry
  // path, since nothing re-triggers the fetch effect on eviction alone.
  // Evicting only what's off-screen means the budget can be temporarily
  // exceeded while everything visible genuinely needs to stay in memory,
  // which is the correct tradeoff over breaking a currently-visible image.
  for (const candidate of lruOrder.keys()) {
    if (totalBytes <= MAX_CACHE_BYTES) break;
    if (candidate === url) continue;
    if ((listeners.get(candidate)?.size ?? 0) > 0) continue;
    evict(candidate);
  }
}

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL('../workers/imageResize.worker.ts', import.meta.url), {
      type: 'module',
    });
    worker.onmessage = (event: MessageEvent<ResizeResult>) => {
      const { id, success, blob, byteSize } = event.data;
      const url = idToUrl.get(id);
      idToUrl.delete(id);
      if (!url) return;

      const next: CacheEntry = success && blob
        ? { status: 'ready', blobUrl: URL.createObjectURL(blob), byteSize: byteSize ?? blob.size }
        : { status: 'error', blobUrl: null, byteSize: 0 };
      setEntry(url, next);
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

    if (cache.has(url)) {
      touch(url);
    } else {
      setEntry(url, { status: 'loading', blobUrl: null, byteSize: 0 });
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
