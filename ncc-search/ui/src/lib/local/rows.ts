import type { NostrEvent } from '@nostrify/nostrify';
import { nip19 } from 'nostr-tools';

import type { ResultKind, SearchResult } from '@/lib/api';
import { postedAtOf } from '@shared/postedAt.js';
import { stripMarkdown } from '@shared/markdown.js';

import type { LocalRow } from './types';

// Relay-native content, i.e. everything an nsite can build without a server:
// no endpoint fetches, so no NCC resolution and no article HTML. The Node
// crawler indexes the same kinds plus the text it can fetch from endpoints
// (see ../src/adapters/).
export const CRAWL_KINDS = [30023, 20, 21, 22, 34235, 34236, 15128, 35128, 9900, 30059] as const;

const KIND_PROFILE = 0;
const KIND_ARTICLE = 30023;
const KIND_PICTURE = 20;
const KIND_NSITE_ROOT = 15128;
const KIND_NSITE_NAMED = 35128;
const KIND_NPACK_RELEASE = 9900;
const KIND_NCC_SERVICE = 30059;

const ADDRESSABLE_KINDS = new Set([30023, 34235, 34236, 35128, 9900]);

// Bounds chosen for a browser index, not a server one. Articles are the only
// kind that regularly produce large text; the rest are titles and summaries.
// Anything longer is truncated for search rather than stored -- the article
// preview fetches the real event from relays when opened, so this copy is not
// what the reader sees.
const BODY_LIMIT = 4_000;
const DESCRIPTION_LIMIT = 600;
const TITLE_LIMIT = 300;

const VIDEO_KINDS = new Set([21, 22, 34235, 34236]);
const IMAGE_EXTENSION_RE = /\.(avif|gif|jpe?g|png|webp)(?:[?#].*)?$/i;
const VIDEO_EXTENSION_RE = /\.(mp4|m4v|mov|webm|ogv|mkv)(?:[?#].*)?$/i;

export function rowKey(kind: ResultKind, pubkey: string, itemId: string): string {
  return `${kind}\u0000${pubkey}\u0000${itemId}`;
}

function clip(value: string | null | undefined, max: number): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

function tagValue(event: NostrEvent, name: string, index = 1): string | null {
  const tag = event.tags.find((entry) => entry[0] === name);
  return tag?.[index]?.trim() || null;
}

function hashtagsOf(event: NostrEvent): string[] | null {
  const tags = [...new Set(
    event.tags
      .filter((tag) => tag[0] === 't' && tag[1])
      .map((tag) => tag[1].trim().toLowerCase())
      .filter(Boolean),
  )].slice(0, 12);
  return tags.length ? tags : null;
}

/** One `imeta` tag as a key -> first value map (NIP-92 entries are `"key value"` strings). */
function imetaFields(tag: string[]): Map<string, string> {
  const fields = new Map<string, string>();
  for (const entry of tag.slice(1)) {
    const space = entry.indexOf(' ');
    if (space <= 0) continue;
    const key = entry.slice(0, space);
    if (!fields.has(key)) fields.set(key, entry.slice(space + 1).trim());
  }
  return fields;
}

function guessMediaType(url: string | null, declared: string | null): string | null {
  if (declared) return declared;
  if (!url) return null;
  if (IMAGE_EXTENSION_RE.test(url)) return `image/${url.match(IMAGE_EXTENSION_RE)?.[1]?.replace('jpg', 'jpeg') ?? 'jpeg'}`;
  if (VIDEO_EXTENSION_RE.test(url)) return `video/${url.match(VIDEO_EXTENSION_RE)?.[1]?.replace('ogv', 'ogg') ?? 'mp4'}`;
  return null;
}

function contentWarningOf(event: NostrEvent): string | null {
  const tag = event.tags.find((entry) => entry[0] === 'content-warning');
  if (!tag) return null;
  return tag[1]?.trim() || 'sensitive content';
}

function bodyOf(event: NostrEvent): string | null {
  return clip(stripMarkdown(event.content ?? ''), BODY_LIMIT);
}

function baseRow(event: NostrEvent, now: number, kind: ResultKind, itemId: string): LocalRow {
  return {
    key: rowKey(kind, event.pubkey, itemId),
    pubkey: event.pubkey,
    itemId,
    kind,
    eventId: event.id ?? null,
    eventCreatedAt: Number.isFinite(event.created_at) ? event.created_at : 0,
    firstSeenAt: now,
    updatedAt: now,
    postedAt: postedAtOf(event),
    title: null,
    description: null,
    body: null,
    endpoint: null,
    mediaUrl: null,
    mediaType: null,
    thumbnailUrl: null,
    blurhash: null,
    thumbhash: null,
    hashtags: null,
    contentWarning: null,
  };
}

function articleRow(event: NostrEvent, now: number): LocalRow | null {
  const itemId = tagValue(event, 'd');
  if (!itemId) return null;
  const row = baseRow(event, now, 'article', itemId);
  row.title = clip(tagValue(event, 'title'), TITLE_LIMIT);
  row.description = clip(tagValue(event, 'summary'), DESCRIPTION_LIMIT);
  row.thumbnailUrl = tagValue(event, 'image');
  row.hashtags = hashtagsOf(event);
  row.body = bodyOf(event);
  return row;
}

function mediaRow(event: NostrEvent, now: number): LocalRow | null {
  const isVideo = VIDEO_KINDS.has(event.kind);
  const itemId = ADDRESSABLE_KINDS.has(event.kind) ? tagValue(event, 'd') : event.id;
  if (!itemId) return null;

  // NIP-68/71: the first imeta with a url is the file itself; `image` is a
  // poster frame for a video. An event with no imeta url is skipped, exactly
  // like the Node adapter -- there is nothing to render or link.
  const metas = event.tags.filter((tag) => tag[0] === 'imeta').map(imetaFields);
  const primary = metas.find((fields) => fields.get('url')) ?? null;
  const url = primary?.get('url') ?? null;
  if (!url) return null;

  const row = baseRow(event, now, isVideo ? 'video' : 'image', itemId);
  row.mediaUrl = url;
  row.mediaType = guessMediaType(url, primary?.get('m') ?? tagValue(event, 'm'));
  row.thumbnailUrl = isVideo
    ? (primary?.get('image') ?? null)
    : url;
  row.blurhash = primary?.get('blurhash') ?? tagValue(event, 'blurhash');
  row.thumbhash = primary?.get('thumbhash') ?? tagValue(event, 'thumbhash');
  row.title = clip(tagValue(event, 'title'), TITLE_LIMIT);
  row.description = clip(tagValue(event, 'summary') ?? tagValue(event, 'alt'), DESCRIPTION_LIMIT);
  row.contentWarning = contentWarningOf(event);
  row.hashtags = hashtagsOf(event);
  const alts = metas.map((fields) => fields.get('alt')).filter(Boolean) as string[];
  row.body = clip(stripMarkdown([event.content ?? '', ...alts].join(' ')), BODY_LIMIT);
  return row;
}

function nsiteRow(event: NostrEvent, now: number): LocalRow | null {
  const isRoot = event.kind === KIND_NSITE_ROOT;
  const itemId = isRoot ? '_root' : tagValue(event, 'd');
  if (!itemId) return null;

  const row = baseRow(event, now, isRoot ? 'nsite-root' : 'nsite-named', itemId);
  row.title = clip(tagValue(event, 'title'), TITLE_LIMIT);
  row.description = clip(tagValue(event, 'description'), DESCRIPTION_LIMIT);
  row.endpoint = entryPathOf(event);
  // The Node crawler indexes the entry page's extracted text; a browser can't
  // fetch arbitrary HTML (CORS), so only the manifest's own title/description
  // are searchable here. That is a real coverage difference, not a bug --
  // ui/README.md's nsite edition section documents it.
  row.body = clip([row.title, row.description].filter(Boolean).join(' '), BODY_LIMIT);
  return row;
}

/** NIP-5A's entry page: `/index.html` when published, else the first HTML path. */
function entryPathOf(event: NostrEvent): string | null {
  const paths = event.tags
    .filter((tag) => tag[0] === 'path' && tag[1])
    .map((tag) => tag[1]);
  if (paths.includes('/index.html')) return '/index.html';
  return paths.find((path) => path.endsWith('.html')) ?? null;
}

function npackRow(event: NostrEvent, now: number): LocalRow | null {
  const itemId = tagValue(event, 'd');
  const name = tagValue(event, 'name');
  const version = tagValue(event, 'version');
  if (!itemId || !name || !version) return null;

  const os = tagValue(event, 'os');
  const arch = tagValue(event, 'arch');
  const platform = os && os !== 'any' && arch && arch !== 'any' ? ` (${os}/${arch})` : '';

  const row = baseRow(event, now, 'npack', itemId);
  row.title = clip(`${name} ${version}${platform}`, TITLE_LIMIT);
  row.description = clip(tagValue(event, 'summary') ?? tagValue(event, 'description'), DESCRIPTION_LIMIT);
  row.endpoint = tagValue(event, 'homepage');
  row.hashtags = [...new Set(
    event.tags.filter((tag) => tag[0] === 'category' && tag[1]).map((tag) => tag[1].trim().toLowerCase()),
  )].slice(0, 12);
  row.body = clip(tagValue(event, 'description') ?? '', BODY_LIMIT);
  // The download link lives on a separate kind:1063 artifact event, which the
  // Node crawler resolves and joins in (npack-crawl.js). Indexing that join
  // here would mean fetching artifacts for every package; the listing is
  // still searchable and links to its homepage, so this stays out of v1.
  return row;
}

function nccServiceRow(event: NostrEvent, now: number): LocalRow | null {
  const itemId = tagValue(event, 'd');
  if (!itemId) return null;
  const endpoint = tagValue(event, 'u');
  let host: string | null = null;
  try {
    host = endpoint ? new URL(endpoint).host : null;
  } catch {
    host = null;
  }
  const row = baseRow(event, now, 'ncc-service', itemId);
  // No resolution happens here -- this is the anchor event the service itself
  // published, not a fetched/served title. Using the service id as the title
  // (and the endpoint host as searchable text) is the honest maximum.
  row.title = clip(itemId, TITLE_LIMIT);
  row.endpoint = endpoint;
  row.body = clip([itemId, host, endpoint].filter(Boolean).join(' '), BODY_LIMIT);
  return row;
}

function profileRow(event: NostrEvent, now: number): LocalRow | null {
  let metadata: Record<string, unknown>;
  try {
    metadata = JSON.parse(event.content);
  } catch {
    return null;
  }
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;

  const str = (value: unknown) =>
    typeof value === 'string' && value.trim() ? value.trim() : null;
  const name = str(metadata.display_name) ?? str(metadata.displayName) ?? str(metadata.name);
  const about = str(metadata.about);

  const row = baseRow(event, now, 'profile', '_profile');
  row.title = clip(name, TITLE_LIMIT);
  row.description = clip(about, DESCRIPTION_LIMIT);
  row.thumbnailUrl = str(metadata.picture);
  row.endpoint = str(metadata.website);
  // The claimed NIP-05 handle is searchable but never displayed as a verified
  // identity: the local index does its own DNS/HTTP verification nowhere, and
  // an unverified claim must not be shown as if confirmed (same stance as the
  // Node crawler). It goes in `body`, which is never rendered.
  row.body = clip(
    [str(metadata.name), str(metadata.display_name), str(metadata.nip05), about]
      .filter(Boolean)
      .join(' '),
    BODY_LIMIT,
  );
  return row;
}

/**
 * Turns a relay event into an index row, or null when the event is not one
 * this edition indexes or is too incomplete to be a result (a manifest with
 * no `d`, a kind:0 with broken JSON, a picture with no imeta url -- the same
 * conditions the Node adapters reject).
 */
export function eventToRow(event: NostrEvent, now: number): LocalRow | null {
  if (!event?.pubkey || !event.id) return null;
  switch (event.kind) {
    case KIND_ARTICLE:
      return articleRow(event, now);
    case KIND_PICTURE:
    case 21:
    case 22:
    case 34235:
    case 34236:
      return mediaRow(event, now);
    case KIND_NSITE_ROOT:
    case KIND_NSITE_NAMED:
      return nsiteRow(event, now);
    case KIND_NPACK_RELEASE:
      return npackRow(event, now);
    case KIND_NCC_SERVICE:
      return nccServiceRow(event, now);
    case KIND_PROFILE:
      return profileRow(event, now);
    default:
      return null;
  }
}

/**
 * Newer event wins per key, matching a replaceable/addressable event's own
 * semantics. Equal `created_at` keeps the copy already indexed: two relays
 * serving the same event must not make it look "updated" on every crawl.
 */
export function shouldReplace(existing: LocalRow | undefined, candidate: LocalRow): boolean {
  if (!existing) return true;
  return candidate.eventCreatedAt > existing.eventCreatedAt;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * A snippet with the backend's own `[`/`]` match markers (see Snippet.tsx),
 * so the same component renders both indexes. There is no FTS5 here, so this
 * finds the first query term in the text and takes a window around it;
 * bracketed text is stripped first because those are the delimiter (and
 * source text containing brackets would otherwise render as a mark).
 */
export function makeSnippet(text: string | null, query: string): string {
  if (!text) return '';
  const terms = [...new Set(String(query ?? '').match(/[\p{L}\p{N}_]+/gu) ?? [])]
    .filter((term) => term.length >= 2)
    .slice(0, 8);
  if (terms.length === 0) return '';

  const clean = text.replace(/[[\]]/g, ' ').replace(/\s+/g, ' ').trim();
  const firstMatch = new RegExp(terms.map(escapeRegExp).join('|'), 'iu').exec(clean);
  if (!firstMatch) return '';

  const WINDOW_BEFORE = 60;
  const WINDOW_AFTER = 150;
  let start = Math.max(0, firstMatch.index - WINDOW_BEFORE);
  let end = Math.min(clean.length, firstMatch.index + WINDOW_AFTER);
  if (start > 0) {
    const space = clean.indexOf(' ', start);
    if (space !== -1 && space < firstMatch.index) start = space + 1;
  }
  if (end < clean.length) {
    const space = clean.lastIndexOf(' ', end);
    if (space > firstMatch.index) end = space;
  }

  const window = clean.slice(start, end);
  const marked = window.replace(
    new RegExp(`(?:${terms.map(escapeRegExp).join('|')})[\\p{L}\\p{N}_]*`, 'giu'),
    (match) => `[${match}]`,
  );
  return `${start > 0 ? '…' : ''}${marked}${end < clean.length ? '…' : ''}`;
}

function safeNpub(pubkey: string): string | null {
  try {
    return nip19.npubEncode(pubkey);
  } catch {
    return null;
  }
}

/** Row -> the exact payload `/search` returns, so components cannot tell the indexes apart. */
export function toSearchResult(row: LocalRow, query: string): SearchResult {
  const snippetSource = row.body && row.body.length > 0 ? row.body : row.description;
  const snippet = makeSnippet(snippetSource, query);
  return {
    pubkey: row.pubkey,
    npub: safeNpub(row.pubkey),
    nip05: null,
    itemId: row.itemId,
    kind: row.kind,
    endpoint: row.endpoint,
    anchored: 0,
    attestationCount: 0,
    lastReachableAt: null,
    indexedAt: row.updatedAt * 1000,
    postedAt: row.postedAt != null ? row.postedAt * 1000 : null,
    lastStatus: null,
    title: row.title,
    description: row.description,
    ...(snippet ? { snippet } : {}),
    mediaUrl: row.mediaUrl,
    mediaType: row.mediaType,
    thumbnailUrl: row.thumbnailUrl,
    blurhash: row.blurhash,
    thumbhash: row.thumbhash,
    hashtags: row.hashtags,
    contentWarning: row.contentWarning,
    source: 'index',
    eventId: row.eventId ?? undefined,
    alternates: [],
  };
}
