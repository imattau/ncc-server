// Plain-text extraction lives in shared/ so the nsite edition's browser
// crawler produces the same searchable text from the same article (see
// shared/markdown.js). Re-exported here so every existing backend import
// keeps working unchanged.
export { stripMarkdown, MAX_PLAIN_TEXT } from '../../shared/markdown.js';
