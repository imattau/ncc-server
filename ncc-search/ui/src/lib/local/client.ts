import type { SearchResponse, SearchSort, SearchStatus } from '@/lib/api';

import { loadSettings, saveSettings, DEFAULT_SETTINGS } from './settings';
import type { LocalClientMessage, LocalCrawlStatus, LocalSettings, LocalWorkerMessage } from './types';

// Main-thread side of the nsite edition. Components keep importing `search()`
// and `getStatus()` from lib/api.ts; that module delegates here when the build
// (or a runtime override) selects local mode, so nothing downstream knows the
// difference.

declare global {
  interface Window {
    /** `local` forces the in-browser index (the nsite build sets it). */
    NCC_SEARCH_MODE?: string;
  }
}

const START_TIMEOUT_MS = 30_000;

let worker: Worker | null = null;
let bootError: string | null = null;
let bootReject: ((error: Error) => void) | null = null;
let readyPromise: Promise<void> | null = null;
let nextId = 1;
const pending = new Map<number, { resolve: (response: SearchResponse) => void; reject: (error: Error) => void }>();

let latestStatus: LocalCrawlStatus | null = null;
const statusListeners = new Set<(status: LocalCrawlStatus) => void>();

export function isLocalMode(): boolean {
  const declared = window.NCC_SEARCH_MODE ?? import.meta.env.VITE_NCC_SEARCH_MODE;
  return declared === 'local';
}

function computeStatusFromLocal(status: LocalCrawlStatus): SearchStatus {
  const connected = status.relays.filter((relay) => relay.state === 'connected').length;
  const failed = status.relays.filter((relay) => relay.state === 'failed').length;
  const connecting = status.relays.filter((relay) => relay.state === 'connecting').length;
  const failureCount = status.relays.reduce((total, relay) => total + relay.failureCount, 0);
  const crawlerState: 'starting' | 'healthy' | 'degraded' | 'unavailable' =
    status.phase === 'loading'
      ? 'starting'
      : status.relays.length === 0
        ? 'unavailable'
        : failed > 0 && connected === 0 && connecting === 0 && status.phase !== 'crawling'
          ? 'degraded'
          : 'healthy';
  return {
    ok: true,
    checkedAt: Date.now(),
    index: {
      recordCount: status.recordCount,
      rowsByKind: status.rowsByKind,
      storage: {
        databaseBytes: status.bytesStored ?? 0,
        diskBytes: status.bytesStored ?? 0,
        limitBytes: status.settings.maxBytes,
        freeBytes: null,
      },
    },
    crawlers: {
      local: {
        relayCount: status.relays.length,
        connectedRelays: connected,
        connectingRelays: connecting,
        failedRelays: failed,
        failureCount,
        processingFailureCount: 0,
        lastEventAt: status.lastEventAt,
        lastSuccessfulSyncAt: status.lastSuccessfulSyncAt,
        lastFailureAt: status.lastFailureAt,
        state: crawlerState,
        // Only warn when every relay is down: one relay timing out is normal
        // for a public relay and would otherwise flash a permanent-looking
        // "results may be incomplete" banner on every page load. The per-relay
        // detail stays in the panel's settings.
        incomplete:
          status.phase !== 'loading' &&
          status.relays.length > 0 &&
          failed > 0 &&
          connected === 0 &&
          connecting === 0,
        relays: status.relays.map((relay) => ({
          url: relay.url,
          connected: relay.state === 'connected' ? true : relay.state === 'failed' ? false : null,
          failureCount: relay.failureCount,
          lastError: relay.lastError,
        })),
      },
    },
  };
}

export function getLocalStatus(): LocalCrawlStatus | null {
  return latestStatus;
}

/** The worker's boot error, if it had one -- shown by the status panel. */
export function getLocalBootError(): string | null {
  return bootError;
}

export function subscribeLocalStatus(listener: (status: LocalCrawlStatus) => void): () => void {
  statusListeners.add(listener);
  if (latestStatus) listener(latestStatus);
  return () => statusListeners.delete(listener);
}

function handleMessage(message: LocalWorkerMessage): void {
  if (message.type === 'status') {
    latestStatus = message.status;
    for (const listener of statusListeners) listener(message.status);
    return;
  }
  if (message.type === 'search') {
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    request.resolve(message.response as SearchResponse);
    return;
  }
  if (message.type === 'error') {
    bootError = message.message;
    bootReject?.(new Error(message.message));
    if (message.id != null) {
      const request = pending.get(message.id);
      if (request) {
        pending.delete(message.id);
        request.reject(new Error(message.message));
      }
    }
  }
}

let visibilityPauseInstalled = false;

/**
 * A crawl is background work the reader did not ask to keep running once they
 * switched away. Pausing on hide (and resuming on show) also stops a phone in
 * a pocket from reconnecting to relays for an hour. A *manual* pause is left
 * alone: only the pause this function caused is undone on return.
 */
function installVisibilityPause(): void {
  if (visibilityPauseInstalled || typeof document === 'undefined') return;
  visibilityPauseInstalled = true;
  let autoPaused = false;
  document.addEventListener('visibilitychange', () => {
    if (!worker) return;
    if (document.visibilityState === 'hidden') {
      if (latestStatus?.phase === 'crawling') {
        autoPaused = true;
        worker.postMessage({ type: 'pause' } satisfies LocalClientMessage);
      }
    } else if (autoPaused) {
      autoPaused = false;
      worker.postMessage({ type: 'resume' } satisfies LocalClientMessage);
    }
  });
}

function startWorker(): Worker {
  if (worker) return worker;
  if (typeof Worker === 'undefined') throw new Error('This browser cannot run the local index.');
  worker = new Worker(new URL('./crawler.ts', import.meta.url), {
    type: 'module',
    name: 'ncc-search-local',
  });
  worker.addEventListener('message', (event: MessageEvent<LocalWorkerMessage>) => handleMessage(event.data));
  worker.addEventListener('error', (event) => {
    bootError = event.message || 'The local index worker stopped.';
    bootReject?.(new Error(bootError));
    for (const request of pending.values()) request.reject(new Error(bootError));
    pending.clear();
    // Drop the dead worker so the next search starts a fresh one instead of
    // posting into a worker that will never answer.
    worker = null;
  });

  // Asking for persistent storage is what keeps the index across visits;
  // without it a browser under storage pressure may evict this origin. A
  // refusal is not an error -- the index still works, it may just be cleared
  // one day.
  void navigator.storage?.persist?.().catch(() => false);

  installVisibilityPause();
  worker.postMessage({
    type: 'start',
    settings: loadSettings(),
    crawl: true,
  } satisfies LocalClientMessage);
  return worker;
}

/**
 * Starts the crawl worker on first use. The landing page calls `getStatus()`
 * for its record count, which means simply opening the page begins indexing --
 * that is the whole "it crawls only while it's running" model.
 */
function ensureReady(): Promise<void> {
  if (!isLocalMode()) return Promise.resolve();
  if (readyPromise) return readyPromise;

  readyPromise = new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      bootReject = null;
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(
      () => finish(new Error(bootError ?? 'The local index took too long to start.')),
      START_TIMEOUT_MS,
    );
    bootReject = (error) => finish(error);

    if (latestStatus) {
      finish();
      return;
    }
    let unsubscribe = () => {};
    unsubscribe = subscribeLocalStatus(() => {
      unsubscribe();
      finish();
    });
    try {
      startWorker();
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
    }
  });
  // A rejected boot is reported to whoever awaited it; this only keeps the
  // rejection from also surfacing as an unhandled promise rejection.
  readyPromise.catch(() => undefined);
  return readyPromise;
}

export async function searchLocal(
  query: string,
  opts: { limit?: number; offset?: number; sort?: SearchSort } = {},
): Promise<SearchResponse> {
  await ensureReady();
  const target = startWorker();
  const id = nextId++;
  return new Promise<SearchResponse>((resolve, reject) => {
    // The worker is in this page's process; a query that never answers means
    // it crashed or is wedged, and a rejected search shows an error with a
    // retry instead of a skeleton that never resolves.
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('The local index did not answer. Reload the page to restart it.'));
    }, 20_000);
    pending.set(id, {
      resolve: (response) => {
        clearTimeout(timer);
        resolve(response);
      },
      reject: (error) => {
        clearTimeout(timer);
        reject(error);
      },
    });
    target.postMessage({
      type: 'search',
      id,
      query,
      limit: opts.limit ?? 20,
      offset: opts.offset ?? 0,
      sort: opts.sort ?? 'relevance',
    } satisfies LocalClientMessage);
  });
}

export async function getLocalStatusAsync(): Promise<SearchStatus> {
  if (!isLocalMode()) throw new Error('The local index is not enabled.');
  await ensureReady();
  if (!latestStatus) throw new Error('The local index is not available.');
  return computeStatusFromLocal(latestStatus);
}

export function currentSettings(): LocalSettings {
  return latestStatus?.settings ?? loadSettings();
}

export function updateLocalSettings(settings: LocalSettings): LocalSettings {
  const normalized = saveSettings(settings);
  startWorker().postMessage({ type: 'settings', settings: normalized } satisfies LocalClientMessage);
  return normalized;
}

export function resetLocalSettings(): LocalSettings {
  return updateLocalSettings(DEFAULT_SETTINGS);
}

export function pauseLocalCrawl(): void {
  startWorker().postMessage({ type: 'pause' } satisfies LocalClientMessage);
}

export function resumeLocalCrawl(): void {
  startWorker().postMessage({ type: 'resume' } satisfies LocalClientMessage);
}

export function clearLocalIndex(): void {
  startWorker().postMessage({ type: 'clear' } satisfies LocalClientMessage);
}
