// Intentionally not a full Markdown parser/renderer -- this only turns
// Markdown content into plain text for indexing (snippets, matching), never
// for display. A real parser dependency would be overkill for that; a handful
// of regexes covering the common syntax is sufficient and keeps this module
// dependency-free.
//
// Shared between the Node crawler (NIP-23 articles and NIP-50 hits) and the
// nsite edition's in-browser crawler, so the same article produces the same
// searchable text and the same snippet whichever index it is in.
//
// The cap is deliberately generous (the caller stores a smaller slice): this
// module's job is text extraction, and a caller that wants less can slice.
const MAX_PLAIN_TEXT = 20_000;

/** @param {string} markdown @returns {string} plain text, trimmed and capped */
export function stripMarkdown(markdown) {
  if (!markdown) return '';
  return markdown
    .replace(/```[\s\S]*?```/g, ' ') // fenced code blocks
    .replace(/`([^`]*)`/g, '$1') // inline code
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1') // images -> alt text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // links -> link text
    .replace(/^#{1,6}\s+/gm, '') // headings
    .replace(/^>\s?/gm, '') // blockquotes
    .replace(/^[-*+]\s+/gm, '') // bullet markers
    .replace(/^\d+\.\s+/gm, '') // ordered list markers
    .replace(/[*_~]{1,3}([^*_~]+)[*_~]{1,3}/g, '$1') // bold/italic/strike
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_PLAIN_TEXT);
}

export { MAX_PLAIN_TEXT };
