import { nip19 } from 'nostr-tools';

// Only http(s) links are ever rendered as a clickable href. NCC-02/NCC-05
// endpoints can legitimately be wss://, onion://, tcp:// too, but those
// aren't things a browser can navigate to directly, and this never trusts
// an unvalidated scheme from relay-published data either way (see
// test-app/AGENTS.md's XSS guidance: sanitize every event-sourced URL
// before using it as href).
export function sanitizeHref(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol === 'http:' || url.protocol === 'https:') return url.toString();
  } catch {
    // not a parseable absolute URL -- fall through to null
  }
  return null;
}

// ncc-browser's own address parser (src/shared/nsite-url.ts there) only
// reads a path's first segment as a named site's `d` tag when it matches
// this grammar -- anything else is read as a file path inside the
// author's root site instead. A NIP-5A `d` tag has no character
// restriction of its own, so a site whose tag doesn't fit this gets no
// link at all here rather than one that would silently resolve to the
// wrong resource.
const NSITE_SITE_ID_RE = /^[a-z0-9-]{1,13}$/;

function isValidNsiteSiteId(value: string): boolean {
  return NSITE_SITE_ID_RE.test(value) && !value.endsWith('-');
}

/**
 * Builds an `nsite://` link for a root or named NIP-5A site.
 * `itemId` is `'_root'` for a root site (see src/adapters/nsite.js's
 * `resolveSite`), everything else a named site's `d` tag.
 *
 * The host is always an npub, never a 64-character hex pubkey. Both parse
 * as an nsite address, but ncc-browser's shells turn the host into a
 * virtual hostname: Android loads `<host>.<site>.nsite.localhost`. A DNS
 * label is limited to 63 characters, and an npub is 63 while a hex pubkey
 * is 64 -- so a hex host is an address that can never resolve there. Live
 * NIP-50 nsite hits arrive without `npub` (see src/adapters/nip50.js), which
 * made this fallback reachable; encode one instead of emitting it.
 */
export function nsiteHref(pubkey: string, npub: string | null | undefined, itemId: string): string | null {
  const host = npub || safeNpub(pubkey);
  if (!host) return null;
  if (itemId === '_root') return `nsite://${host}`;
  return isValidNsiteSiteId(itemId) ? `nsite://${host}/${itemId}` : null;
}

function safeNpub(pubkey: string): string | null {
  try {
    return nip19.npubEncode(pubkey);
  } catch {
    // Not a hex pubkey and no npub supplied: no link rather than a hostname
    // that cannot work.
    return null;
  }
}
