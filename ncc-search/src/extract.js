// Lightweight content extraction for the pages a resolved endpoint serves.
// Deliberately not a headless browser: NCC-02/NCC-05 target static/self-hosted
// services and nsites, which this project assumes render useful content
// without JS execution (consistent with this repo's own MKStack test page
// being a static build).

import { load } from 'cheerio';

/**
 * @param {string} html
 * @returns {{ title: string|null, description: string|null, text: string }}
 */
export function extractDocument(html) {
  const $ = load(html);
  const title = $('title').first().text().trim() || null;
  const description =
    $('meta[name="description"]').attr('content')?.trim() ||
    $('meta[property="og:description"]').attr('content')?.trim() ||
    null;

  $('script, style, noscript').remove();
  const text = $('body').text().replace(/\s+/g, ' ').trim().slice(0, 20_000);

  return { title, description, text };
}
