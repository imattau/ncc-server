import { useEffect, useState } from 'react';
import type { ProbeRequest, ProbeResult } from '@/workers/mediaProbe.worker';

export type ProbeStatus = 'checking' | 'reachable' | 'unreachable';

// One shared worker for the whole page (not one per result row) -- probing
// is cheap and I/O-bound, no need to spin up dozens of worker threads for a
// results page. Results are cached by URL at module scope so switching tabs
// or re-rendering never re-probes a URL this page already checked.
let worker: Worker | null = null;
const resultCache = new Map<string, ProbeStatus>();
const listeners = new Map<string, Set<(status: ProbeStatus) => void>>();
const idToUrl = new Map<string, string>();
let nextId = 0;

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL('../workers/mediaProbe.worker.ts', import.meta.url), {
      type: 'module',
    });
    worker.onmessage = (event: MessageEvent<ProbeResult>) => {
      const { id, reachable } = event.data;
      const url = idToUrl.get(id);
      idToUrl.delete(id);
      if (!url) return;
      const status: ProbeStatus = reachable ? 'reachable' : 'unreachable';
      resultCache.set(url, status);
      listeners.get(url)?.forEach((notify) => notify(status));
    };
  }
  return worker;
}

/** Client-side reachability check for a media URL, run in a Web Worker. */
export function useMediaProbe(url: string | null | undefined): ProbeStatus | null {
  const [status, setStatus] = useState<ProbeStatus | null>(
    url ? (resultCache.get(url) ?? null) : null,
  );

  useEffect(() => {
    if (!url) return;

    const cached = resultCache.get(url);
    if (cached) {
      setStatus(cached);
      return;
    }

    setStatus('checking');
    let set = listeners.get(url);
    if (!set) {
      set = new Set();
      listeners.set(url, set);
    }
    set.add(setStatus);

    const id = String(nextId++);
    idToUrl.set(id, url);
    const request: ProbeRequest = { id, url };
    getWorker().postMessage(request);

    return () => {
      listeners.get(url)?.delete(setStatus);
    };
  }, [url]);

  return status;
}
