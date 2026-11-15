// NIP-23 long-form content ("articles"/"blog posts") adapter.
//
// Unlike every other adapter here, there is no fetch/verify step at all:
// `kind:30023` is an addressable event whose `content` field IS the
// article, in Markdown, inline. Discovery hands us the full record already
// resolved. That makes this the simplest adapter in the project -- a single
// discover-and-store pass, no re-crawl scheduling beyond what the ambient
// relay subscription naturally delivers when a newer version is published
// (addressable: pubkey+kind+d replaces in place, same as NCC-02/NCC-05).
//
// Source: NIP-23 (nostr-protocol/nips), read directly for this adapter.
//   - kind 30023 (addressable; kind 30024 is deprecated drafts, not indexed)
//   - `d` (required for addressable semantics), `title`, `image`, `summary`,
//     `published_at` (all optional per spec, but an article with no `d`
//     can't be a stable identity, so it's skipped here same as nsite skips
//     malformed manifests)

import { stripMarkdown } from './markdown.js';

export const KIND_ARTICLE_EVENT = 30023;

/**
 * @param {import('nostr-tools').SimplePool} pool
 * @param {string[]} relays
 * @param {(event: object) => void} onArticle
 * @param {{ since?: number }} [options]
 */
export function discoverArticles(pool, relays, onArticle, options = {}) {
  const filter = { kinds: [KIND_ARTICLE_EVENT] };
  if (options.since) filter.since = options.since;

  const sub = pool.subscribeMany(relays, [filter], {
    onevent(event) {
      const dTag = event.tags.find((t) => t[0] === 'd')?.[1];
      if (!dTag) return;
      onArticle(event);
    },
    oneose() {},
  });

  return { close: () => sub.close() };
}

/** @param {object} event a kind:30023 event @returns {ResolvedArticle} */
export function resolveArticle(event) {
  const dTag = event.tags.find((t) => t[0] === 'd')?.[1];
  const title = event.tags.find((t) => t[0] === 'title')?.[1] || null;
  const summary = event.tags.find((t) => t[0] === 'summary')?.[1] || null;
  const image = event.tags.find((t) => t[0] === 'image')?.[1] || null;
  const publishedAt = event.tags.find((t) => t[0] === 'published_at')?.[1] || null;
  const body = stripMarkdown(event.content);

  return {
    pubkey: event.pubkey,
    itemId: dTag,
    kind: 'article',
    title,
    description: summary,
    body,
    thumbnailUrl: image,
    mediaUrl: null,
    mediaType: null,
    endpoint: null,
    publishedAt: publishedAt ? Number(publishedAt) : null,
  };
}

/**
 * @typedef {Object} ResolvedArticle
 * @property {string} pubkey
 * @property {string} itemId - the `d` tag
 * @property {'article'} kind
 * @property {string|null} title
 * @property {string|null} description - the `summary` tag
 * @property {string} body - markdown content, stripped to plain text
 * @property {string|null} thumbnailUrl - the `image` tag
 * @property {null} mediaUrl
 * @property {null} mediaType
 * @property {null} endpoint
 * @property {number|null} publishedAt
 */
