import type { ResultKind, SearchResult } from '@/lib/api';

// Media kinds the blur applies to. Articles/nsites/profiles carry no
// publisher-tagged media of their own, and this backend only resolves a
// `content-warning` for NIP-68/71 media (see src/adapters/media.js).
const BLUR_KINDS = new Set<ResultKind>(['image', 'video', 'short-video']);

// NIP-68/71's `content-warning` tag value is free text, so this is a
// deliberately forgiving keyword match rather than an equality check: real
// publishers write "nsfw", "NSFW", "nudity", "18+" and so on. A bare
// `["content-warning"]` tag becomes "sensitive content" server-side (see
// src/adapters/media.js) and is treated as blur-worthy too, since the
// publisher asked for exactly that. Unrelated warnings ("flashing lights")
// are left alone.
const NSFW_WARNING_RE =
  /(?:^|[^a-z0-9])(nsfw|nsfl|not safe for work|explicit|porn|xxx|nude|nudity|naked|sexual|adult|18\+|mature|sensitive content|graphic|gore)(?:[^a-z0-9]|$)/i;

/** Whether a publisher's `content-warning` label should blur its media. */
export function isNsfwWarning(value: string | null | undefined): boolean {
  return value ? NSFW_WARNING_RE.test(value) : false;
}

/**
 * Whether this result's own preview should be blurred behind a reveal
 * control. Only the publisher's tag decides -- the app makes no judgment of
 * its own, same as safe search.
 */
export function shouldBlurMedia(
  result: Pick<SearchResult, 'kind' | 'contentWarning'>,
): boolean {
  return BLUR_KINDS.has(result.kind) && isNsfwWarning(result.contentWarning);
}
