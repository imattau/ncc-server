// Shared validation for relay URLs that this server will connect to.
//
// Used by two callers with the same threat model:
//   - NIP-65 relay learning, where a relay URL comes from a public event;
//   - /search's optional client-relay fan-out, where it comes from a query
//     parameter on a public, unauthenticated endpoint.
//
// Only `wss://` is accepted: `ws://` would let a caller aim the server at a
// plaintext local service, and every public relay this index talks to is TLS.
// Credentials and fragments are refused, as are localhost/.local names and
// private/loopback/link-local IP literals. A hostname that resolves to a
// private address is not caught here -- Node resolves it later inside `ws` --
// but literals and obviously-local names, which are the cheap attacks, are.
// This is the same check relay learning already applied; it lives here so the
// API and the crawler cannot drift.

export function safePublicRelayUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'wss:' || url.username || url.password || url.hash) return null;
    const host = url.hostname.toLowerCase();
    if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return null;
    // `.onion` would make this server dial through its own Tor proxy on a
    // public request's behalf; public relay URLs are clearnet.
    if (host.endsWith('.onion')) return null;
    if (isPrivateIp(host)) return null;
    return url.href;
  } catch {
    return null;
  }
}

export function isPrivateIp(host) {
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const [a, b] = ipv4.slice(1).map(Number);
    if ([a, b].some((part) => part > 255)) return true;
    return a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  const ipv6 = host.replace(/^\[|\]$/g, '').toLowerCase();
  return ipv6 === '::' || ipv6 === '::1' || ipv6.startsWith('::ffff:') || ipv6.startsWith('fc') || ipv6.startsWith('fd') || ipv6.startsWith('fe8') || ipv6.startsWith('fe9') || ipv6.startsWith('fea') || ipv6.startsWith('feb');
}
