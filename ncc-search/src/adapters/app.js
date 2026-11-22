// NIP-82 software-application adapter (kind 32267), the event Zapstore uses
// for app listings.
//
// NIP-82 ("Software Applications") is a draft in nostr-protocol/nips
// (pull request #2526, titled "Zapstore spec"; there is no merged 82.md yet),
// so this adapter follows the tag shape the spec and Zapstore's own client
// use in practice:
//   - kind 32267: addressable application listing
//     REQUIRED `d` (app id, typically a reverse-domain package name) and
//     `name`; OPTIONAL `summary`, `icon`, repeated `image`, repeated `t`,
//     `url`, `repository`, `license`, and REQUIRED-MULTIPLE `f` platform
//     identifiers (e.g. `android-arm64-v8a`, `linux-x86_64`, `web`).
//   - kind 30063 (release) and 3063 (asset) are deliberately not indexed
//     here: one search result per app listing is what a reader expects, and
//     resolving the latest release's assets would be a second join for no
//     extra search value.
//
// No fetch or reachability check: the app's icon is loaded by the reader's
// browser, and the store page is opened there too -- this process never
// downloads an APK.

import { discoverFromRelays } from '../relayDiscovery.js';
import { postedAtOf } from '../postedAt.js';
import { zapstoreAppUrl } from '../../shared/zapstore.js';
import { extractHashtags } from './hashtags.js';
import { stripMarkdown } from './markdown.js';

export const KIND_APP = 32267;
export const APP_KINDS = [KIND_APP];

const BODY_LIMIT = 20_000;

function tagValue(event, name) {
  return event.tags.find((tag) => tag[0] === name)?.[1]?.trim() || null;
}

function tagValues(event, name) {
  return [...new Set(
    event.tags.filter((tag) => tag[0] === name && tag[1]?.trim()).map((tag) => tag[1].trim()),
  )];
}

/**
 * @param {import('nostr-tools').SimplePool} pool
 * @param {string[]} relays
 * @param {(event: object) => void} onApp
 * @param {{ since?: number, store?: object, monitor?: object }} [options]
 */
export function discoverApps(pool, relays, onApp, options = {}) {
  const filter = { kinds: APP_KINDS };
  return discoverFromRelays(pool, relays, 'apps', filter, (event) => {
    if (event.tags.some((tag) => tag[0] === 'd' && tag[1])) onApp(event);
  }, options);
}

/**
 * @param {object} event a kind 32267 event
 * @returns {ResolvedApp|null} null when there is no stable id or display
 *   name -- a listing this incomplete is not a usable search result either.
 */
export function resolveApp(event) {
  const itemId = tagValue(event, 'd');
  const name = tagValue(event, 'name');
  if (!itemId || !name) return null;

  const summary = tagValue(event, 'summary');
  const platforms = tagValues(event, 'f');
  const body = stripMarkdown(event.content ?? '').trim().slice(0, BODY_LIMIT);

  return {
    pubkey: event.pubkey,
    itemId,
    kind: 'app',
    title: name,
    description: summary,
    body: body || null,
    thumbnailUrl: tagValue(event, 'icon'),
    endpoint: zapstoreAppUrl(itemId),
    platforms: platforms.length ? platforms : null,
    postedAt: postedAtOf(event),
    hashtags: extractHashtags(event),
  };
}

/**
 * @typedef {Object} ResolvedApp
 * @property {string} pubkey
 * @property {string} itemId - the `d` tag (app id)
 * @property {'app'} kind
 * @property {string} title - the `name` tag
 * @property {string|null} description - the `summary` tag
 * @property {string|null} body - `content`, stripped to plain text
 * @property {string|null} thumbnailUrl - the `icon` tag
 * @property {string|null} endpoint - the Zapstore listing URL
 * @property {string[]|null} platforms - `f` tags
 * @property {number|null} postedAt
 * @property {string[]} hashtags - from `t` tags, lowercased; [] if none
 */
