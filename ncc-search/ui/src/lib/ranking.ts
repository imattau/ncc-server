import type { SearchResult } from '@/lib/api';

export interface PersonalizationContext {
  follows: Set<string>;
  interests: Set<string>;
}

// A result from someone the user follows outranks a hashtag-interest match,
// which outranks nothing. These are boost scores on top of whatever order
// the backend already returned (FTS relevance), not a replacement for it --
// see rankResults's stable tie-break.
const FOLLOW_BOOST = 2;
const INTEREST_BOOST = 1;

function scoreResult(result: SearchResult, ctx: PersonalizationContext): number {
  let score = 0;
  if (ctx.follows.has(result.pubkey)) score += FOLLOW_BOOST;
  const hashtags = result.hashtags ?? [];
  if (hashtags.some((tag) => ctx.interests.has(tag.toLowerCase()))) score += INTEREST_BOOST;
  return score;
}

/**
 * Re-ranks results for a logged-in user: higher score first, and -- this is
 * the part that matters -- results with an equal score keep the backend's
 * original relative order (its FTS relevance ranking) rather than whatever
 * order `Array.prototype.sort` would otherwise leave them in. Explicit
 * index tie-break rather than relying on sort stability, so this holds
 * regardless of JS engine.
 *
 * Returns `results` unchanged (same reference) when there's no
 * personalization context or it's empty, so a logged-out search is never
 * touched by this at all.
 */
export function rankResults(
  results: SearchResult[],
  ctx: PersonalizationContext | null,
): SearchResult[] {
  if (!ctx || (ctx.follows.size === 0 && ctx.interests.size === 0)) return results;

  return results
    .map((result, index) => ({ result, index, score: scoreResult(result, ctx) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.result);
}

/** Whether a result got any personalization boost at all -- for a UI indicator, not used in sorting itself. */
export function isFollowed(result: SearchResult, ctx: PersonalizationContext | null): boolean {
  return !!ctx && ctx.follows.has(result.pubkey);
}
