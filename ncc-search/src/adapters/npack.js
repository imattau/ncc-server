// npack adapter -- indexes npack (github.com/imattau/npack) package
// releases so .npk software releases show up in search, same as any other
// Nostr-native content this project indexes.
//
// npack is a project protocol, not yet a registered NIP (source:
// imattau/npack, docs/package-protocol-v1.md, read directly for this
// adapter):
//   - kind 9900: a signed release event. Required singleton tags: `d`
//     (`<name>/<version>/<arch>`), `v` ("1"), `name`, `version`, `os`,
//     `arch`, `format` (normally `npk`), `x` (lowercase sha256 of the
//     artifact), `artifact` (the kind:1063 NIP-94 event id carrying the
//     download URL(s)). Optional store-listing tags: `summary`,
//     `description`, `homepage`, `license`, `release-date`, `icon`
//     (`[url, sha256]`); repeatable `category` (up to 8).
//   - kind 1063: NIP-94 generic file metadata -- the release's own
//     `artifact` tag points at one of these for the actual download `url`
//     and MIME type (`m`). A release and its artifact are two separate
//     events (from the same publisher) that can arrive in either order,
//     unlike nsite's manifest-is-the-record shape -- see npack-crawl.js for
//     how the two are joined.
//
// This backend never fetches/verifies the `.npk` bytes themselves (same
// stance media.js takes on image/video bytes) -- a package manager client
// does that; this is a search index, not an installer.

import { discoverFromRelays } from '../relayDiscovery.js';
import { postedAtOf } from '../postedAt.js';

export const KIND_NPACK_RELEASE = 9900;
export const KIND_NPACK_ARTIFACT = 1063;

const MAX_CATEGORIES = 8;

/**
 * @param {import('nostr-tools').SimplePool} pool
 * @param {string[]} relays
 * @param {(event: object) => void} onRelease
 * @param {{ since?: number, store?: object, monitor?: object }} [options]
 */
export function discoverNpackReleases(pool, relays, onRelease, options = {}) {
  const filter = { kinds: [KIND_NPACK_RELEASE] };
  return discoverFromRelays(pool, relays, 'npack-releases', filter, onRelease, options);
}

/**
 * @param {import('nostr-tools').SimplePool} pool
 * @param {string[]} relays
 * @param {(event: object) => void} onArtifact
 * @param {{ since?: number, store?: object, monitor?: object }} [options]
 */
export function discoverNpackArtifacts(pool, relays, onArtifact, options = {}) {
  const filter = { kinds: [KIND_NPACK_ARTIFACT] };
  return discoverFromRelays(pool, relays, 'npack-artifacts', filter, onArtifact, options);
}

function tagValue(event, name) {
  return event.tags.find((t) => t[0] === name)?.[1] || null;
}

const SHA256_RE = /^[0-9a-f]{64}$/;

/**
 * @param {object} event a kind:9900 event
 * @returns {ResolvedNpackRelease|null} null if the event is missing an
 *   identity (`d`) or any of the other required singleton tags this backend
 *   needs to show/link a listing -- a release this incomplete isn't a
 *   usable search result either way.
 */
export function resolveNpackRelease(event) {
  const dTag = tagValue(event, 'd');
  const name = tagValue(event, 'name');
  const version = tagValue(event, 'version');
  const os = tagValue(event, 'os');
  const arch = tagValue(event, 'arch');
  const sha256 = tagValue(event, 'x');
  const artifactId = tagValue(event, 'artifact');
  if (!dTag || !name || !version || !artifactId || !sha256 || !SHA256_RE.test(sha256)) return null;

  const summary = tagValue(event, 'summary');
  const description = tagValue(event, 'description');
  const homepage = tagValue(event, 'homepage');
  const categories = [...new Set(
    event.tags.filter((t) => t[0] === 'category' && t[1]).map((t) => t[1]),
  )].slice(0, MAX_CATEGORIES);

  const platform = os && os !== 'any' && arch && arch !== 'any' ? ` (${os}/${arch})` : '';

  return {
    pubkey: event.pubkey,
    itemId: dTag,
    kind: 'npack',
    name,
    version,
    os: os || 'any',
    arch: arch || 'any',
    sha256: sha256.toLowerCase(),
    artifactId,
    title: `${name} ${version}${platform}`,
    description: summary || description || null,
    body: description || null,
    homepage,
    postedAt: postedAtOf(event),
    hashtags: categories.length ? categories : null,
  };
}

/**
 * @param {object} event a kind:1063 NIP-94 event
 * @returns {ResolvedNpackArtifact|null} null if it has no usable `url` tag
 */
export function resolveNpackArtifact(event) {
  const url = tagValue(event, 'url');
  if (!url) return null;
  return {
    id: event.id,
    url,
    mediaType: tagValue(event, 'm'),
  };
}

/**
 * Joins a resolved release with its artifact (once known) into the shape
 * `store.upsertContent` expects. `artifact` may be null if the kind:1063
 * event hasn't arrived yet -- the listing is still indexable by name/
 * summary/description, just without a download link until npack-crawl.js
 * re-upserts it when the artifact shows up.
 *
 * @param {ResolvedNpackRelease} release
 * @param {ResolvedNpackArtifact|null} artifact
 */
export function toSearchRow(release, artifact) {
  return {
    pubkey: release.pubkey,
    itemId: release.itemId,
    kind: 'npack',
    title: release.title,
    description: release.description,
    body: release.body,
    mediaUrl: artifact?.url ?? null,
    mediaType: artifact?.mediaType ?? null,
    thumbnailUrl: null,
    endpoint: release.homepage,
    postedAt: release.postedAt ?? null,
    hashtags: release.hashtags,
  };
}

/**
 * @typedef {Object} ResolvedNpackRelease
 * @property {string} pubkey
 * @property {string} itemId - the `d` tag (`<name>/<version>/<arch>`)
 * @property {'npack'} kind
 * @property {string} name
 * @property {string} version
 * @property {string} os
 * @property {string} arch
 * @property {string} sha256 - lowercase, the `x` tag
 * @property {string} artifactId - the kind:1063 event id, the `artifact` tag
 * @property {string} title
 * @property {string|null} description - `summary`, falling back to `description`
 * @property {string|null} body - the full `description` tag
 * @property {string|null} homepage
 * @property {string[]|null} hashtags - `category` tags, up to 8
 *
 * @typedef {Object} ResolvedNpackArtifact
 * @property {string} id
 * @property {string} url
 * @property {string|null} mediaType
 */
