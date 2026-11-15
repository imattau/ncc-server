// Lightweight content extraction for the pages a resolved endpoint serves.
// Deliberately not a headless browser: NCC-02/NCC-05 target static/self-hosted
// services and nsites, which this project assumes render useful content
// without JS execution (consistent with this repo's own MKStack test page
// being a static build).

import { load } from 'cheerio';

// Only an absolute http(s) URL is usable as a thumbnail: a static site is
// fetched here as a single verified Blossom blob (see adapters/nsite.js),
// not from its own domain, so there is no base URL a page-relative
// `og:image` (e.g. "/cover.png") could be resolved against. An
// unresolvable claim is dropped, not guessed at -- same approach this
// codebase already takes for an unverifiable NIP-05 claim (nsite.js's
// resolveNip05).
function absoluteHttpUrl(value) {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? value : null;
  } catch {
    return null;
  }
}

/**
 * @param {string} html
 * @returns {{ title: string|null, description: string|null, text: string, image: string|null }}
 */
export function extractDocument(html) {
  const $ = load(html);
  const title = $('title').first().text().trim() || null;
  const description =
    $('meta[name="description"]').attr('content')?.trim() ||
    $('meta[property="og:description"]').attr('content')?.trim() ||
    null;
  const image = absoluteHttpUrl(
    $('meta[property="og:image"]').attr('content')?.trim() ||
      $('meta[name="twitter:image"]').attr('content')?.trim() ||
      null,
  );

  $('script, style, noscript').remove();
  const text = $('body').text().replace(/\s+/g, ' ').trim().slice(0, 20_000);

  return { title, description, text, image };
}
