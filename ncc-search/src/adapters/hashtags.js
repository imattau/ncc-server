// Shared `t`-tag (hashtag) extraction, used by article.js and media.js --
// both NIP-23 and NIP-68/71 define `["t", "<hashtag>"]` the same way. Not
// used by NCC-02/NCC-05/nsite: none of those conventions define a hashtag
// tag, so there's nothing to extract there.
//
// Feeds src/ranking consumers indirectly: the UI uses these to prioritize
// results against a logged-in NIP-07 user's interests (see
// ui/src/hooks/useInterests.ts and ui/src/lib/ranking.ts). This backend
// itself does no ranking -- it only indexes the tags.

/** @param {object} event @returns {string[]} lowercased, deduplicated hashtags, or [] if none */
export function extractHashtags(event) {
  const seen = new Set();
  for (const tag of event.tags) {
    if (tag[0] !== 't' || !tag[1]) continue;
    seen.add(tag[1].toLowerCase());
  }
  return [...seen];
}
