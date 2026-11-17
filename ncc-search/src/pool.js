// One relay pool per process, shared by everything in that process, so no
// adapter opens its own set of relay connections.
//
// Both entrypoints use this: src/index.js (the crawler) opens the
// subscriptions that discover content and the NIP-65 learning queries that
// widen them, and src/api.js (the read-only API) opens the short-lived NIP-50
// live-search queries. They are separate processes on purpose -- see
// README.md's "Two processes" section -- so they do not share connections,
// only this configuration.

import { SimplePool } from 'nostr-tools';
import { WebSocket } from 'ws';

// `websocketImplementation` is NOT cosmetic: nostr-tools' SimplePool
// defaults to Node's native (undici-based) global `WebSocket`. That
// implementation's `AbstractRelay.onerror` handler calls `this.ws.close()`
// synchronously from inside the socket's own `error` event -- which, on a
// failed/refused connection, re-enters undici's internal
// failWebsocketConnection/closeWebSocketConnection dispatch and recurses
// until the stack overflows, crashing the entire process. Reproduced this
// directly (both against an unreachable port and against a momentary error
// from a real public relay) while building the UI against this backend.
// The `ws` package (already a dependency the sidecar itself uses for the
// same reason) implements the same onopen/onmessage/onerror/onclose
// interface without that reentrancy bug, so every relay connection this
// process makes goes through it instead of the native implementation.
class PoolWebSocket extends WebSocket {
  constructor(...args) {
    super(...args);
    // nostr-tools closes a relay socket when its connection timer expires.
    // `ws` emits an `error` when that happens before the handshake completes;
    // without a listener Node treats it as an uncaught EventEmitter error and
    // terminates the whole search process. Relay failures are already handled
    // by nostr-tools' close/error callbacks, so keep the event from crashing
    // this long-lived service.
    this.on('error', () => {});
  }
}

export function createPool() {
  const pool = new SimplePool({ websocketImplementation: PoolWebSocket });
  // Lets the crawl adapters record which relay(s) actually served a given
  // event (see relayTracking.js) -- a redundancy signal: a record seen on
  // only one relay is one relay outage away from becoming undiscoverable
  // again, a record seen on several is not. `trackRelays` isn't a
  // constructor option (checked against nostr-tools' own source); it's a
  // plain field that must be set after construction.
  pool.trackRelays = true;
  return pool;
}

/**
 * `SimplePool.close()` takes an explicit relay list (`relays.map(...)`, so
 * calling it with nothing throws). Close whatever this process actually
 * connected to -- best effort: a shutdown path should never be what stops a
 * service from exiting.
 * @param {InstanceType<typeof SimplePool>|null} pool
 */
export function closePool(pool) {
  if (!pool) return;
  try {
    const connected = typeof pool.relays?.keys === 'function' ? [...pool.relays.keys()] : [];
    pool.close(connected);
  } catch {
    /* nothing left to do at shutdown */
  }
}
