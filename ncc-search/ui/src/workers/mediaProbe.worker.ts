// Runs off the main thread so probing a page full of image/video results
// never blocks scrolling or input -- this is the "worker thread" the backend
// deliberately doesn't do itself (see ../../src/adapters/media.js): the
// backend only ever indexes NIP-68/71 metadata, never fetches media bytes,
// so reachability for a media result is checked here, client-side, instead.
//
// `mode: 'no-cors'` is deliberate: most Blossom/CDN hosts don't send CORS
// headers for a cross-origin HEAD, which would otherwise make every probe
// reject even when the file is perfectly reachable. An opaque no-cors
// response can't be inspected (no status, no headers), but the fetch
// promise still only rejects on an actual network failure -- DNS failure,
// connection refused, timeout -- which is exactly the "is this even up"
// signal this needs. It cannot distinguish a real 404 from reachable; that
// trade-off is acceptable for a background hint, not a security or
// correctness boundary.

export interface ProbeRequest {
  id: string;
  url: string;
}

export interface ProbeResult {
  id: string;
  reachable: boolean;
}

self.onmessage = async (event: MessageEvent<ProbeRequest>) => {
  const { id, url } = event.data;
  let reachable = false;
  try {
    await fetch(url, { method: 'HEAD', mode: 'no-cors', cache: 'no-store' });
    reachable = true;
  } catch {
    reachable = false;
  }
  const result: ProbeResult = { id, reachable };
  (self as unknown as Worker).postMessage(result);
};
