// Canonical Zapstore listing URL for a NIP-82 software application `d` tag.
//
// Zapstore's Android client declares a verified `https://zapstore.dev/apps/*`
// App Link (see its AndroidManifest), so this same URL opens the installed
// store app on mobile and the web listing everywhere else. No custom scheme
// is needed, and a plain http(s) link stays usable by every other browser.
//
// Shared by the Node app adapter (src/adapters/app.js) and the nsite edition's
// browser crawler (ui/src/lib/local/rows.ts) so both editions link the same
// way.

const ZAPSTORE_APP_BASE = 'https://zapstore.dev/apps/';

/**
 * @param {string|null|undefined} appId a NIP-82 application `d` tag
 * @returns {string|null} null when there is no usable id
 */
export function zapstoreAppUrl(appId) {
  if (typeof appId !== 'string') return null;
  const trimmed = appId.trim();
  if (!trimmed) return null;
  return `${ZAPSTORE_APP_BASE}${encodeURIComponent(trimmed)}`;
}
