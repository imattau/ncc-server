// NIP-68 pictures and NIP-71 videos adapter.
//
// Deliberately metadata-only: this backend never fetches image/video bytes.
// The `imeta` tag (NIP-92/NIP-94, extended by NIP-68/71) already carries
// everything needed for search (title/alt/caption text) and everything the
// browser needs to render the media itself directly from its original host
// -- fetching gigabytes of media through this process would be pure cost
// with no benefit over letting the browser load it the way any web page
// would. See ui/src/components/ResultRow.tsx (renders <img>/<video> with
// the stored URL) and ui/src/workers/mediaProbe.worker.ts (the client-side
// reachability check this backend intentionally doesn't do).
//
// Sources: NIP-68 and NIP-71 (nostr-protocol/nips), read directly.
//   - kind 20: picture-first post (regular event, NOT addressable -- every
//     matching event is a distinct, permanent post, so `itemId` is the
//     event id itself, not a `d` tag).
//   - kind 21 / 22: normal / short-form video (regular, same as above).
//   - kind 34235 / 34236: addressable normal / short video variants
//     (`d`-tagged) -- supported for completeness; same tag shape otherwise.
//   - `imeta` tags: repeated space-separated "key value" strings per entry,
//     one `imeta` tag per file. Relevant keys: url, m (MIME type), dim,
//     alt, x (sha256), image (video preview thumbnail), duration.
//   - `title` tag: required by both NIPs.

import { extractHashtags } from './hashtags.js';
import { postedAtOf } from '../postedAt.js';
import { discoverFromRelays } from '../relayDiscovery.js';

export const KIND_PICTURE = 20;
export const KIND_VIDEO_NORMAL = 21;
export const KIND_VIDEO_SHORT = 22;
export const KIND_VIDEO_NORMAL_ADDRESSABLE = 34235;
export const KIND_VIDEO_SHORT_ADDRESSABLE = 34236;

export const MEDIA_KINDS = [
  KIND_PICTURE,
  KIND_VIDEO_NORMAL,
  KIND_VIDEO_SHORT,
  KIND_VIDEO_NORMAL_ADDRESSABLE,
  KIND_VIDEO_SHORT_ADDRESSABLE,
];

/** NIP-71's short-form variants (regular kind 22, addressable kind 34236). */
export const SHORT_VIDEO_KINDS = new Set([KIND_VIDEO_SHORT, KIND_VIDEO_SHORT_ADDRESSABLE]);

const ADDRESSABLE_KINDS = new Set([KIND_VIDEO_NORMAL_ADDRESSABLE, KIND_VIDEO_SHORT_ADDRESSABLE]);

/**
 * The row kind a media event produces. NIP-71 defines short videos as a
 * distinct presentation from normal videos, so they get their own `kind`
 * rather than being merged into `video` and left indistinguishable in the UI.
 * @param {number} eventKind
 * @returns {'image'|'video'|'short-video'}
 */
export function storeKindFor(eventKind) {
  if (eventKind === KIND_PICTURE) return 'image';
  return SHORT_VIDEO_KINDS.has(eventKind) ? 'short-video' : 'video';
}

/**
 * @param {import('nostr-tools').SimplePool} pool
 * @param {string[]} relays
 * @param {(event: object) => void} onMedia
 * @param {{ since?: number, store?: object, monitor?: object }} [options]
 */
export function discoverMedia(pool, relays, onMedia, options = {}) {
  const filter = { kinds: MEDIA_KINDS };
  return discoverFromRelays(pool, relays, 'media', filter, (event) => {
    if (ADDRESSABLE_KINDS.has(event.kind) && !event.tags.some((t) => t[0] === 'd')) return;
    if (event.tags.some((t) => t[0] === 'imeta')) onMedia(event);
  }, options);
}

// parseImetaTag collects a *repeated* key into an array -- correct for
// `fallback` (the only key NIP-92/94 actually expects more than one of),
// but any key can legally repeat in a tag some publisher writes; nothing
// stops a video's `imeta` from, say, two `image` entries. Found this live:
// a real NIP-71 video event crashed the backend with "SQLite3 can only
// bind numbers, strings, bigints, buffers, and null" because `primary.image`
// came back as `['url1', 'url2']` and went straight into a TEXT column.
// Every single-value field this adapter reads off `primary` goes through
// this first, so a repeated key degrades to "use the first one" instead of
// crashing the whole crawl.
function scalar(value) {
  return Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
}

/** Parses one `imeta` tag's "key value" entries into an object. Repeated keys (`fallback`) collect into an array. */
export function parseImetaTag(tag) {
  const result = {};
  for (const field of tag.slice(1)) {
    const spaceIndex = field.indexOf(' ');
    if (spaceIndex === -1) continue;
    const key = field.slice(0, spaceIndex);
    const value = field.slice(spaceIndex + 1);
    if (key in result) {
      result[key] = Array.isArray(result[key]) ? [...result[key], value] : [result[key], value];
    } else {
      result[key] = value;
    }
  }
  return result;
}

/** @param {object} event a kind 20/21/22/34235/34236 event @returns {ResolvedMedia|null} */
export function resolveMedia(event) {
  const imetaTags = event.tags.filter((t) => t[0] === 'imeta').map(parseImetaTag);
  const primary = imetaTags.find((m) => m.url) ?? imetaTags[0];
  if (!primary?.url) return null;

  const dTag = event.tags.find((t) => t[0] === 'd')?.[1];
  const title = event.tags.find((t) => t[0] === 'title')?.[1] || null;
  const altTexts = imetaTags.map((m) => scalar(m.alt)).filter(Boolean);
  const body = [event.content, ...altTexts].filter(Boolean).join(' ').trim().slice(0, 20_000);
  // NIP-68/71 `["content-warning", "<reason>"]`. The reason is optional --
  // presence of the tag at all is what matters for safe search (see ui/'s
  // useSafeSearch), so an empty/missing reason still flags the result,
  // just with a generic label instead of the publisher's own wording.
  const contentWarningTag = event.tags.find((t) => t[0] === 'content-warning');
  const contentWarning = contentWarningTag ? contentWarningTag[1] || 'sensitive content' : null;

  return {
    pubkey: event.pubkey,
    itemId: ADDRESSABLE_KINDS.has(event.kind) ? dTag : event.id,
    kind: storeKindFor(event.kind),
    title,
    description: event.content || altTexts[0] || null,
    body,
    mediaUrl: scalar(primary.url),
    mediaType: scalar(primary.m),
    thumbnailUrl: scalar(primary.image) || (storeKindFor(event.kind) === 'image' ? scalar(primary.url) : null),
    // Both optional per NIP-68/71; parseImetaTag already captures arbitrary
    // keys generically, so these just need picking off `primary`. The UI
    // only decodes `blurhash` today (see ui/'s useBlurhashPlaceholder) --
    // `thumbhash` uses a different binary encoding this project hasn't
    // implemented a decoder for yet, so it's stored for forward
    // compatibility but not currently rendered.
    blurhash: scalar(primary.blurhash),
    thumbhash: scalar(primary.thumbhash),
    endpoint: null,
    duration: scalar(primary.duration) ? Number(scalar(primary.duration)) : null,
    postedAt: postedAtOf(event),
    hashtags: extractHashtags(event),
    contentWarning,
  };
}

/**
 * @typedef {Object} ResolvedMedia
 * @property {string} pubkey
 * @property {string} itemId - event id for regular kinds, `d` tag for addressable ones
 * @property {'image'|'video'|'short-video'} kind
 * @property {string|null} title
 * @property {string|null} description
 * @property {string} body
 * @property {string} mediaUrl
 * @property {string|null} mediaType
 * @property {string|null} thumbnailUrl
 * @property {string|null} blurhash
 * @property {string|null} thumbhash
 * @property {null} endpoint
 * @property {number|null} duration
 * @property {string[]} hashtags - from `t` tags, lowercased; [] if none
 * @property {string|null} contentWarning - from the `content-warning` tag; null if absent
 */
