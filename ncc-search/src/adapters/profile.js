// Nostr profile (kind:0 metadata) adapter -- makes people, not just
// services/sites/content, searchable and browsable (ui/'s dedicated
// "Profiles" grid tab).
//
// kind:0 is replaceable (NIP-01), not addressable: there is no `d` tag, and
// a pubkey has at most one current profile. `itemId` is therefore the fixed
// sentinel `_profile`, same pattern nsite.js uses for a root site's `_root`
// -- a stable per-pubkey identity, not derived from anything that could
// repeat or go missing.
//
// `nip05` is deliberately NOT read off the event's own claimed field here --
// see nsite.js's resolveNip05()/module comment for why an unverified claim
// is never shown as if confirmed. profile-crawl.js reuses that same
// verification pass, exactly like content-crawl.js does for articles/media.

import { discoverFromRelays } from '../relayDiscovery.js';

export const KIND_PROFILE_EVENT = 0;

/**
 * Broad discovery, same pattern as discovery.js/article.js: no pre-existing
 * pubkey list needed.
 *
 * @param {import('nostr-tools').SimplePool} pool
 * @param {string[]} relays
 * @param {(event: object) => void} onProfile
 * @param {{ since?: number, store?: object, monitor?: object }} [options]
 */
export function discoverProfiles(pool, relays, onProfile, options = {}) {
  const filter = { kinds: [KIND_PROFILE_EVENT] };
  return discoverFromRelays(pool, relays, 'profiles', filter, onProfile, options);
}

/**
 * @param {object} event a kind:0 event
 * @returns {ResolvedProfile|null} null if `content` isn't parseable JSON --
 *   a malformed kind:0 isn't a usable profile, same stance nsite.js takes on
 *   a manifest it can't parse.
 */
export function resolveProfile(event) {
  let metadata;
  try {
    metadata = JSON.parse(event.content);
  } catch {
    return null;
  }
  if (!metadata || typeof metadata !== 'object') return null;

  const displayName = str(metadata.display_name) || str(metadata.displayName);
  const name = str(metadata.name);

  return {
    pubkey: event.pubkey,
    itemId: '_profile',
    kind: 'profile',
    title: displayName || name || null,
    description: str(metadata.about),
    body: null,
    thumbnailUrl: str(metadata.picture),
    mediaUrl: null,
    mediaType: null,
    endpoint: str(metadata.website),
    hashtags: null,
  };
}

function str(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * @typedef {Object} ResolvedProfile
 * @property {string} pubkey
 * @property {'_profile'} itemId
 * @property {'profile'} kind
 * @property {string|null} title - `display_name`, falling back to `name`
 * @property {string|null} description - the `about` field
 * @property {null} body
 * @property {string|null} thumbnailUrl - the `picture` field
 * @property {null} mediaUrl
 * @property {null} mediaType
 * @property {string|null} endpoint - the `website` field, if present
 * @property {null} hashtags
 */
