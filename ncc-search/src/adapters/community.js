// NIP-72 moderated-community adapter (kind 34550).
//
// A community definition is an addressable event, usually signed by its
// owner, carrying the community's identity and moderation policy:
//   - kind 34550: REQUIRED `d`; OPTIONAL `name` (displayed instead of `d`
//     when present), `description`, repeated `image`, `p` moderators,
//     `relay` tags, plus any other tags the community uses.
//
// NIP-72 itself is marked "unrecommended" in favour of NIP-29 relay groups,
// but it is the concrete community event publishers actually sign and that
// other NIP-72 clients already read, so it is what this index covers. There
// is no fetch or reachability check: a community has no web endpoint of its
// own, only a relay coordinate (`naddr`), so the row has no external link.

import { discoverFromRelays } from '../relayDiscovery.js';
import { postedAtOf } from '../postedAt.js';
import { extractHashtags } from './hashtags.js';
import { stripMarkdown } from './markdown.js';

export const KIND_COMMUNITY = 34550;
export const COMMUNITY_KINDS = [KIND_COMMUNITY];

const BODY_LIMIT = 20_000;

function tagValue(event, name) {
  return event.tags.find((tag) => tag[0] === name)?.[1]?.trim() || null;
}

/**
 * @param {import('nostr-tools').SimplePool} pool
 * @param {string[]} relays
 * @param {(event: object) => void} onCommunity
 * @param {{ since?: number, store?: object, monitor?: object }} [options]
 */
export function discoverCommunities(pool, relays, onCommunity, options = {}) {
  const filter = { kinds: COMMUNITY_KINDS };
  return discoverFromRelays(pool, relays, 'communities', filter, (event) => {
    if (event.tags.some((tag) => tag[0] === 'd' && tag[1])) onCommunity(event);
  }, options);
}

/**
 * @param {object} event a kind 34550 event
 * @returns {ResolvedCommunity|null} null without a `d` tag; NIP-72 allows
 *   the `d` tag itself to double as the name, so it is also the title
 *   fallback.
 */
export function resolveCommunity(event) {
  const itemId = tagValue(event, 'd');
  if (!itemId) return null;

  const name = tagValue(event, 'name');
  const description = tagValue(event, 'description');
  const body = stripMarkdown(
    [event.content ?? '', description].filter(Boolean).join(' '),
  ).trim().slice(0, BODY_LIMIT);

  return {
    pubkey: event.pubkey,
    itemId,
    kind: 'community',
    title: name || itemId,
    description,
    body: body || null,
    thumbnailUrl: tagValue(event, 'image'),
    // A community's home is a relay coordinate (`naddr`), not a URL, so
    // there is nothing a browser can navigate to here.
    endpoint: null,
    postedAt: postedAtOf(event),
    hashtags: extractHashtags(event),
  };
}

/**
 * @typedef {Object} ResolvedCommunity
 * @property {string} pubkey
 * @property {string} itemId - the `d` tag
 * @property {'community'} kind
 * @property {string} title - the `name` tag, falling back to `d`
 * @property {string|null} description - the `description` tag
 * @property {string|null} body - `content` plus description, stripped to text
 * @property {string|null} thumbnailUrl - the first `image` tag
 * @property {null} endpoint
 * @property {number|null} postedAt
 * @property {string[]} hashtags - from `t` tags, lowercased; [] if none
 */
