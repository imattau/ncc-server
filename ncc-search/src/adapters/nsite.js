// nsite discovery/fetch/extract adapter (NIP-5A: Static Websites), plus a
// NIP-05 enrichment step for the pubkeys it finds.
//
// This is the first adapter added after the NCC-02/NCC-05 one, proving out
// the "additive, not a rewrite" claim from the top-level README: it reuses
// fetchUrl() and extractDocument() unchanged, and only adds its own
// discovery filter, manifest parsing, and Blossom-specific integrity check.
//
// Event shapes (source: NIP-5A, nostr-docs.pages.dev/nip-5a, read directly
// for this adapter -- not inferred from secondary sources):
//   - kind 15128: root site, replaceable, one per pubkey, MUST NOT have a
//     `d` tag.
//   - kind 35128: named site, addressable, MUST have a `d` tag (the site
//     identifier).
//   - kind 34128: legacy per-file events (`d`=path, `x`=sha256). Deprecated;
//     not discovered here -- new sites SHOULD use 15128/35128, and this
//     adapter follows that, same as the spec recommends to publishers.
//   - Path-to-hash mapping lives in repeated `["path", "/abs/path", "<sha256>"]`
//     tags on the manifest event itself, not in a JSON `content` body (the
//     manifest event's content is empty per the spec's own examples) --
//     the manifest event IS the resolved record, there's no separate
//     locator step the way NCC-02/NCC-05 have one.
//   - `["server", "<url>"]` tags hint which Blossom servers to fetch from.
//     If absent, fall back to the pubkey's kind:10063 (BUD-03) server list.
//   - Fetched bytes are verified against the declared sha256 -- this is
//     nsite's integrity mechanism, playing the same role NCC's `k` pin
//     plays for NCC-02/NCC-05.
//
// NIP-05 has no defined relation to nsite in the spec; attaching it here is
// this project's own enrichment, parallel to how NCC-02 attestations add
// trust signal on top of a bare service record: it gives search results a
// verified human-readable handle instead of only a bare npub, and the
// verification (fetch the claimed domain's `.well-known/nostr.json`, check
// the returned pubkey matches) is NIP-05's actual normative check, not a
// guess -- an unverifiable claim is treated as absent, never shown as if
// confirmed.

import crypto from 'node:crypto';
import { fetchUrl } from '../fetcher.js';
import { extractDocument } from '../extract.js';

export const KIND_ROOT_SITE = 15128;
export const KIND_NAMED_SITE = 35128;
export const KIND_BLOSSOM_SERVER_LIST = 10063; // BUD-03
export const KIND_PROFILE = 0;

/**
 * Broad discovery, same pattern as discovery.js: no pre-existing pubkey list
 * needed, these kinds are meant to be publicly discoverable.
 *
 * @param {import('nostr-tools').SimplePool} pool
 * @param {string[]} relays
 * @param {(candidate: { pubkey: string, kind: number, event: object }) => void} onCandidate
 * @param {{ since?: number }} [options]
 */
export function discoverNsites(pool, relays, onCandidate, options = {}) {
  const filter = { kinds: [KIND_ROOT_SITE, KIND_NAMED_SITE] };
  if (options.since) filter.since = options.since;

  // See discovery.js's comment on this same call shape: subscribeMany takes
  // a single filter object here, not `[filter]`.
  const sub = pool.subscribeMany(relays, filter, {
    onevent(event) {
      const dTag = event.tags.find((t) => t[0] === 'd')?.[1] || null;
      // Malformed per spec (root MUST NOT have `d`, named MUST have one).
      if (event.kind === KIND_ROOT_SITE && dTag) return;
      if (event.kind === KIND_NAMED_SITE && !dTag) return;
      onCandidate({ pubkey: event.pubkey, kind: event.kind, event });
    },
    oneose() {},
  });

  return { close: () => sub.close() };
}

/** @param {object} event */
export function parseManifest(event) {
  const paths = new Map();
  const servers = [];
  let title = null;
  let description = null;

  for (const tag of event.tags) {
    if (tag[0] === 'path' && tag[1] && tag[2]) paths.set(tag[1], tag[2]);
    else if (tag[0] === 'server' && tag[1]) servers.push(tag[1]);
    else if (tag[0] === 'title' && tag[1]) title = tag[1];
    else if (tag[0] === 'description' && tag[1]) description = tag[1];
  }

  return { paths, servers, title, description };
}

/** Prefers /index.html, then any .html/.htm path, per the spec's own directory-index convention. */
export function pickEntryPath(paths) {
  if (paths.has('/index.html')) return '/index.html';
  for (const p of paths.keys()) {
    if (p.endsWith('.html') || p.endsWith('.htm')) return p;
  }
  const [first] = paths.keys();
  return first ?? null;
}

function blobUrl(server, sha256) {
  return `${server.replace(/\/+$/, '')}/${sha256}`;
}

function verifyBlobHash(buffer, expectedHex) {
  return crypto.createHash('sha256').update(buffer).digest('hex') === expectedHex.toLowerCase();
}

async function fetchUserBlossomServers(pool, relays, pubkey) {
  try {
    const event = await pool.get(relays, { kinds: [KIND_BLOSSOM_SERVER_LIST], authors: [pubkey] });
    if (!event) return [];
    return event.tags.filter((t) => t[0] === 'server' && t[1]).map((t) => t[1]);
  } catch {
    return [];
  }
}

/**
 * Tries each candidate Blossom server (BUD-01 `GET /<sha256>`) in order
 * until one serves bytes matching the manifest's declared hash -- fails
 * closed the same way NCC's `k` check does, just on content instead of a
 * transport key.
 */
async function fetchVerifiedBlob(servers, sha256, fetchOpts) {
  let lastError = null;
  for (const server of servers) {
    try {
      const res = await fetchUrl(blobUrl(server, sha256), fetchOpts);
      if (res.statusCode >= 400) {
        lastError = new Error(`${server}: HTTP ${res.statusCode}`);
        continue;
      }
      if (!verifyBlobHash(res.bodyBuffer, sha256)) {
        lastError = new Error(`${server}: sha256 mismatch (integrity check failed)`);
        continue;
      }
      return res;
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError || new Error('no Blossom servers available (no `server` tags, no kind:10063)');
}

/**
 * Resolves and verifies a NIP-05 identifier for a pubkey, from its kind:0
 * profile's `nip05` field. Returns null (not a guess, not a half-trusted
 * value) if there is no profile, no `nip05` field, or the domain's
 * `.well-known/nostr.json` doesn't confirm the pubkey.
 *
 * @returns {Promise<string|null>} `name@domain`, or bare `domain` for the `_` identifier
 */
export async function resolveNip05(pool, relays, pubkey, fetchOpts = {}) {
  let profileEvent;
  try {
    profileEvent = await pool.get(relays, { kinds: [KIND_PROFILE], authors: [pubkey] });
  } catch {
    return null;
  }
  if (!profileEvent) return null;

  let profile;
  try {
    profile = JSON.parse(profileEvent.content);
  } catch {
    return null;
  }

  const claim = profile?.nip05;
  if (typeof claim !== 'string' || !claim.includes('@')) return null;
  const [rawName, domain] = claim.split('@');
  if (!domain) return null;
  const name = rawName || '_';

  try {
    const res = await fetchUrl(
      `https://${domain}/.well-known/nostr.json?name=${encodeURIComponent(name)}`,
      fetchOpts,
    );
    if (res.statusCode !== 200) return null;
    const data = JSON.parse(res.body);
    const resolvedHex = data?.names?.[name];
    if (typeof resolvedHex === 'string' && resolvedHex.toLowerCase() === pubkey.toLowerCase()) {
      return name === '_' ? domain : `${name}@${domain}`;
    }
  } catch {
    // Network/parse failure on the verification fetch -- an unverifiable
    // claim is absent, not trusted.
  }
  return null;
}

export class NsiteAdapter {
  /**
   * @param {import('nostr-tools').SimplePool} pool
   * @param {string[]} relays
   * @param {{ fetchTimeoutMs: number, fetchMaxBytes: number, torSocks: string }} config
   */
  constructor(pool, relays, config) {
    this.pool = pool;
    this.relays = relays;
    this.config = config;
  }

  /** @param {object} event the manifest event discovery.js handed us @returns {ResolvedSite} */
  resolveSite(event) {
    const manifest = parseManifest(event);
    const entryPath = pickEntryPath(manifest.paths);
    const dTag = event.tags.find((t) => t[0] === 'd')?.[1] || null;

    return {
      pubkey: event.pubkey,
      kind: event.kind,
      siteId: event.kind === KIND_NAMED_SITE ? dTag : '_root',
      title: manifest.title,
      description: manifest.description,
      entryPath,
      entrySha256: entryPath ? manifest.paths.get(entryPath) : null,
      servers: manifest.servers,
    };
  }

  /** @param {ResolvedSite} resolved @returns {Promise<{status?:number, title?:string|null, description?:string|null, text?:string|null, image?:string|null, error?:string}>} */
  async fetchAndExtract(resolved) {
    if (!resolved.entryPath || !resolved.entrySha256) {
      return { error: 'manifest has no usable entry path' };
    }

    let servers = resolved.servers;
    if (!servers.length) {
      servers = await fetchUserBlossomServers(this.pool, this.relays, resolved.pubkey);
    }
    if (!servers.length) {
      return { error: 'no Blossom servers (no `server` tags, no kind:10063)' };
    }

    const fetchOpts = {
      timeoutMs: this.config.fetchTimeoutMs,
      maxBytes: this.config.fetchMaxBytes,
      torSocksUrl: this.config.torSocks,
    };

    try {
      const blob = await fetchVerifiedBlob(servers, resolved.entrySha256, fetchOpts);
      const doc = extractDocument(blob.body);
      return { status: blob.statusCode, ...doc };
    } catch (err) {
      return { error: String(err && err.message ? err.message : err) };
    }
  }

  async resolveNip05For(pubkey) {
    const fetchOpts = {
      timeoutMs: this.config.fetchTimeoutMs,
      maxBytes: this.config.fetchMaxBytes,
      torSocksUrl: this.config.torSocks,
    };
    return resolveNip05(this.pool, this.relays, pubkey, fetchOpts);
  }
}

/**
 * @typedef {Object} ResolvedSite
 * @property {string} pubkey
 * @property {number} kind - 15128 or 35128
 * @property {string} siteId - the `d` tag, or `_root` for a root site
 * @property {string|null} title
 * @property {string|null} description
 * @property {string|null} entryPath
 * @property {string|null} entrySha256
 * @property {string[]} servers - manifest `server` tag hints, may be empty
 */
