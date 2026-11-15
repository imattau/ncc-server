// Generic HTTP(S)/onion fetch primitive, shared by every content adapter.
// Uses Node's core http/https clients rather than a fetch wrapper so the TLS
// socket's peer certificate is reachable for pin verification, and
// `socks-proxy-agent` for `.onion` endpoints so they're routed through this
// host's existing Tor SOCKS listener instead of needing a separate transport
// stack.
//
// Two adapters build on this, each with its own integrity check rather than
// trusting the transport:
//   - NCC-02/NCC-05 (resolver.js/crawl.js): pins the declared `k` (SPKI
//     fingerprint) and fails closed on mismatch -- see spkiFingerprint().
//   - nsite (adapters/nsite.js): has no key-pinning contract; instead each
//     `path` tag declares the file's sha256, verified in adapters/nsite.js
//     after the fetch (Blossom's own integrity model, BUD-01).

import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import { SocksProxyAgent } from 'socks-proxy-agent';

let onionAgent = null;
function getOnionAgent(torSocksUrl) {
  if (!onionAgent) onionAgent = new SocksProxyAgent(torSocksUrl);
  return onionAgent;
}

/**
 * Matches the sidecar's own `computeKFromCertPem` (ncc-06-js/src/k.js) byte
 * for byte: SHA-256 of the DER SubjectPublicKeyInfo, unpadded base64url (not
 * standard base64). `PeerCertificate.pubkey` as returned by Node's TLS
 * socket is verified (empirically, against a real handshake) to be the same
 * SPKI DER bytes `crypto.createPublicKey(pem).export({type:'spki',format:'der'})`
 * would produce from the full certificate, so no PEM round-trip is needed
 * here. The encoding was the actual mismatch, not the input bytes -- see
 * README "Known caveats".
 * @param {import('tls').PeerCertificate} cert
 */
export function spkiFingerprint(cert) {
  if (!cert || !cert.pubkey) return null;
  return base64url(crypto.createHash('sha256').update(cert.pubkey).digest());
}

function base64url(buffer) {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function toHttpUrl(rawUrl) {
  const url = new URL(rawUrl);
  if (url.protocol === 'wss:') url.protocol = 'https:';
  if (url.protocol === 'ws:') url.protocol = 'http:';
  return url;
}

/**
 * @param {string} rawUrl any http(s)/ws(s)/onion URL -- an NCC endpoint, a
 *   Blossom blob URL, a `.well-known/nostr.json` lookup, etc.
 * @param {{ expectedFingerprint?: string|null, timeoutMs?: number, maxBytes?: number, torSocksUrl?: string, headers?: Record<string,string> }} [opts]
 *   `expectedFingerprint` only applies to NCC-style `k` pinning; omit it for
 *   fetches that have no such contract (nsite blobs, NIP-05 lookups, NIP-11
 *   relay info documents). `headers` is for requests that need one set, e.g.
 *   NIP-11's `Accept: application/nostr+json`.
 */
export function fetchUrl(rawUrl, opts = {}) {
  const {
    expectedFingerprint = null,
    timeoutMs = 10_000,
    maxBytes = 1_000_000,
    torSocksUrl = 'socks5h://127.0.0.1:9050',
    headers,
  } = opts;

  const url = toHttpUrl(rawUrl);
  const isOnion = url.hostname.endsWith('.onion');
  const isSecure = url.protocol === 'https:';
  const transport = isSecure ? https : http;

  return new Promise((resolve, reject) => {
    const req = transport.request(
      url,
      {
        agent: isOnion ? getOnionAgent(torSocksUrl) : undefined,
        timeout: timeoutMs,
        headers,
        // NCC-02/05 endpoints are commonly self-signed; both conventions pin
        // the transport key explicitly (`k`) instead of relying on a CA
        // chain, so we disable ambient cert validation and do our own
        // fail-closed fingerprint check below rather than trusting the OS
        // trust store either way.
        rejectUnauthorized: false,
      },
      (res) => {
        let observedFingerprint = null;
        if (isSecure && !isOnion && typeof res.socket.getPeerCertificate === 'function') {
          observedFingerprint = spkiFingerprint(res.socket.getPeerCertificate(true));
          if (expectedFingerprint && observedFingerprint !== expectedFingerprint) {
            req.destroy();
            reject(
              new Error(
                `k-mismatch: expected ${expectedFingerprint}, observed ${observedFingerprint}`,
              ),
            );
            return;
          }
        }

        const chunks = [];
        let size = 0;
        res.on('data', (chunk) => {
          size += chunk.length;
          if (size > maxBytes) {
            req.destroy();
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          const bodyBuffer = Buffer.concat(chunks);
          resolve({
            statusCode: res.statusCode,
            contentType: res.headers['content-type'] || '',
            // Raw bytes for callers that need to hash/verify before decoding
            // (nsite's sha256 check); decoded text for HTML extraction.
            bodyBuffer,
            body: bodyBuffer.toString('utf8'),
            observedFingerprint,
          });
        });
        res.on('error', reject);
      },
    );
    req.on('timeout', () => req.destroy(new Error('fetch timed out')));
    req.on('error', reject);
    req.end();
  });
}

// NCC call sites read better as "fetch the resolved endpoint"; same function.
export const fetchResolvedEndpoint = fetchUrl;
