// Intentionally not a full Markdown parser/renderer -- this only needs to
// turn NIP-23 article content into plain text for FTS indexing (snippets,
// matching), never for display. A real parser dependency would be overkill
// for that; a handful of regexes covering the common syntax is sufficient
// and keeps this adapter dependency-free, same spirit as extract.js using
// cheerio only for HTML, not a browser engine.

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
    .slice(0, 20_000);
}
