// NIP-52 calendar events adapter.
//
// Like articles and media, there is no fetch/verify step: the event itself
// carries everything a search result can show (title, summary, cover, date,
// location, hashtags). The browser opens the event's own `r` link when the
// publisher supplied one; nothing is proxied through this backend.
//
// Source: NIP-52 (nostr-protocol/nips), read directly.
//   - kind 31922: date-based, `start`/`end` are YYYY-MM-DD (end exclusive)
//   - kind 31923: time-based, `start`/`end` are unix seconds
//   - common: `d` (required), `title` (required; `name` is a deprecated
//     fallback), `summary`, `image`, repeated `location`, repeated `r`,
//     `t` hashtags, repeated `p` participants
//   - 31924 (calendar collection) and 31925 (RSVP) are deliberately not
//     indexed: a collection is not a result a reader can attend, and an RSVP
//     is a private response, not content.

import { extractHashtags } from './hashtags.js';
import { postedAtOf } from '../postedAt.js';
import { discoverFromRelays } from '../relayDiscovery.js';
import { stripMarkdown } from './markdown.js';

export const KIND_CALENDAR_DATE = 31922;
export const KIND_CALENDAR_TIME = 31923;
export const CALENDAR_KINDS = [KIND_CALENDAR_DATE, KIND_CALENDAR_TIME];

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * @param {import('nostr-tools').SimplePool} pool
 * @param {string[]} relays
 * @param {(event: object) => void} onEvent
 * @param {{ since?: number, store?: object, monitor?: object }} [options]
 */
export function discoverEvents(pool, relays, onEvent, options = {}) {
  const filter = { kinds: CALENDAR_KINDS };
  return discoverFromRelays(pool, relays, 'events', filter, (event) => {
    if (event.tags.some((tag) => tag[0] === 'd' && tag[1])) onEvent(event);
  }, options);
}

function tagValue(event, name) {
  return event.tags.find((tag) => tag[0] === name)?.[1]?.trim() || null;
}

/** YYYY-MM-DD -> unix seconds at UTC midnight; null when malformed. */
function dateOnlySeconds(value) {
  if (!value || !DATE_ONLY_RE.test(value)) return null;
  const ms = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

function unixSeconds(value) {
  if (!value) return null;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : null;
}

/** The first `r` link that is an absolute http(s) URL, if any. */
function eventLink(event) {
  for (const tag of event.tags) {
    if (tag[0] !== 'r' || typeof tag[1] !== 'string' || !tag[1].trim()) continue;
    try {
      const url = new URL(tag[1].trim());
      if (url.protocol === 'http:' || url.protocol === 'https:') return url.href;
    } catch {
      // not a URL; try the next r tag
    }
  }
  return null;
}

/**
 * @param {object} event a kind 31922/31923 event
 * @returns {ResolvedEvent|null} null for a record with no stable identity or
 *   no title -- same stance the nsite/media adapters take on malformed input
 */
export function resolveEvent(event) {
  const itemId = tagValue(event, 'd');
  if (!itemId) return null;

  const title = tagValue(event, 'title') ?? tagValue(event, 'name');
  if (!title) return null;

  const dateOnly = event.kind === KIND_CALENDAR_DATE;
  const locations = event.tags
    .filter((tag) => tag[0] === 'location' && tag[1]?.trim())
    .map((tag) => tag[1].trim());
  const summary = tagValue(event, 'summary');
  const description = summary ?? null;

  return {
    pubkey: event.pubkey,
    itemId,
    kind: 'event',
    title,
    description,
    // Location is part of what someone searches for ("Berlin", "online"), so
    // it belongs in the FTS body even though the UI also shows it directly.
    body: stripMarkdown([event.content, summary, ...locations].filter(Boolean).join(' ')).slice(0, 20_000),
    thumbnailUrl: tagValue(event, 'image'),
    endpoint: eventLink(event),
    allDay: dateOnly ? 1 : 0,
    startsAt: dateOnly
      ? dateOnlySeconds(tagValue(event, 'start'))
      : unixSeconds(tagValue(event, 'start')),
    endsAt: dateOnly
      ? dateOnlySeconds(tagValue(event, 'end'))
      : unixSeconds(tagValue(event, 'end')),
    location: locations.length ? locations.join(' · ') : null,
    status: null,
    postedAt: postedAtOf(event),
    hashtags: extractHashtags(event),
  };
}

/**
 * @typedef {Object} ResolvedEvent
 * @property {string} pubkey
 * @property {string} itemId - the `d` tag
 * @property {'event'} kind
 * @property {string} title
 * @property {string|null} description - the `summary` tag
 * @property {string} body - description + location, stripped to plain text
 * @property {string|null} thumbnailUrl - the `image` tag
 * @property {string|null} endpoint - the first http(s) `r` link
 * @property {0|1} allDay - 1 for date-based events (kind 31922)
 * @property {number|null} startsAt - unix seconds
 * @property {number|null} endsAt - unix seconds
 * @property {string|null} location - repeated `location` tags joined for display
 * @property {null} status - NIP-52 has no status field
 * @property {number|null} postedAt - the event's created_at (no published_at)
 * @property {string[]} hashtags - from `t` tags, lowercased; [] if none
 */
