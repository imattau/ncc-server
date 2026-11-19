// NIP-53 live streaming events adapter (kind 30311).
//
// A live event is addressable and continuously updated while the stream runs
// (status, participant list, start/end timestamps), so the ambient
// subscription's newest-copy-wins upsert keeps the row current. No fetch or
// reachability check: the stream URL is opened by the reader's browser, not
// by this process.
//
// Source: NIP-53 (nostr-protocol/nips), read directly.
//   - kind 30311: `d`, `title`, `summary`, `image`, repeated `t`,
//     `streaming` and `recording` URLs, `starts`/`ends` (unix seconds),
//     `status` = planned | live | ended, `current_participants`,
//     `total_participants`, `p` participants with roles
//   - kind 1311 (live chat) and 30312/30313 (meeting spaces) are not
//     indexed: chat is not a search result, and meeting spaces are a separate
//     feature with their own lifecycle.

import { extractHashtags } from './hashtags.js';
import { postedAtOf } from '../postedAt.js';
import { discoverFromRelays } from '../relayDiscovery.js';
import { stripMarkdown } from './markdown.js';

export const KIND_LIVE_STREAM = 30311;
export const LIVE_STREAM_KINDS = [KIND_LIVE_STREAM];

export const LIVE_STATUSES = new Set(['planned', 'live', 'ended']);

/**
 * @param {import('nostr-tools').SimplePool} pool
 * @param {string[]} relays
 * @param {(event: object) => void} onEvent
 * @param {{ since?: number, store?: object, monitor?: object }} [options]
 */
export function discoverLiveStreams(pool, relays, onEvent, options = {}) {
  const filter = { kinds: LIVE_STREAM_KINDS };
  return discoverFromRelays(pool, relays, 'live-streams', filter, (event) => {
    if (event.tags.some((tag) => tag[0] === 'd' && tag[1])) onEvent(event);
  }, options);
}

function tagValue(event, name) {
  return event.tags.find((tag) => tag[0] === name)?.[1]?.trim() || null;
}

function unixSeconds(value) {
  if (!value) return null;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : null;
}

/** The stream to open: the live stream while running, otherwise the recording. */
function streamLink(event) {
  const candidates = [tagValue(event, 'streaming'), tagValue(event, 'recording')];
  for (const value of candidates) {
    if (!value) continue;
    try {
      const url = new URL(value);
      if (url.protocol === 'http:' || url.protocol === 'https:') return url.href;
    } catch {
      // not a URL; try the next tag
    }
  }
  return null;
}

/**
 * @param {object} event a kind 30311 event
 * @returns {ResolvedLiveStream|null}
 */
export function resolveLiveStream(event) {
  const itemId = tagValue(event, 'd');
  if (!itemId) return null;

  const title = tagValue(event, 'title');
  if (!title) return null;

  const summary = tagValue(event, 'summary');
  const status = tagValue(event, 'status');
  const participants = Number(tagValue(event, 'current_participants'));

  return {
    pubkey: event.pubkey,
    itemId,
    kind: 'live-stream',
    title,
    description: summary,
    body: stripMarkdown([event.content, summary].filter(Boolean).join(' ')).slice(0, 20_000),
    thumbnailUrl: tagValue(event, 'image'),
    endpoint: streamLink(event),
    allDay: 0,
    startsAt: unixSeconds(tagValue(event, 'starts')),
    endsAt: unixSeconds(tagValue(event, 'ends')),
    location: null,
    status: status && LIVE_STATUSES.has(status) ? status : null,
    participantCount: Number.isFinite(participants) && participants >= 0 ? participants : null,
    postedAt: postedAtOf(event),
    hashtags: extractHashtags(event),
  };
}

/**
 * @typedef {Object} ResolvedLiveStream
 * @property {string} pubkey
 * @property {string} itemId - the `d` tag
 * @property {'live-stream'} kind
 * @property {string} title
 * @property {string|null} description - the `summary` tag
 * @property {string} body - summary/content, stripped to plain text
 * @property {string|null} thumbnailUrl - the `image` tag
 * @property {string|null} endpoint - streaming URL, falling back to recording
 * @property {0} allDay
 * @property {number|null} startsAt - unix seconds
 * @property {number|null} endsAt - unix seconds
 * @property {null} location - live streams have no location tag
 * @property {'planned'|'live'|'ended'|null} status - publisher-declared
 * @property {number|null} participantCount - current_participants
 * @property {number|null} postedAt - the event's latest created_at
 * @property {string[]} hashtags - from `t` tags, lowercased; [] if none
 */
