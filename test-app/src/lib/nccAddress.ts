/**
 * Resolve the node operator npub without depending on a deploy-created file.
 *
 * NCC Browser serves each service from an address whose host starts with the
 * operator npub (`npub1…`, `npub1….admin`), so that is the authoritative
 * identity when the page itself was reached over ncc://. The welcome page and
 * the admin panel also accept `/ncc-config.json`, which may carry either the
 * bech32 npub or the hex pubkey that Caddy has in `NCC_OPERATOR_PUBKEY`.
 */

import { nip19 } from 'nostr-tools';

const NPUB_PATTERN = /^npub1[0-9a-z]{20,}$/i;
const PUBKEY_PATTERN = /^[0-9a-f]{64}$/i;

function validNpub(value: string): string | null {
  if (!NPUB_PATTERN.test(value)) return null;

  try {
    return nip19.decode(value).type === 'npub' ? value : null;
  } catch {
    return null;
  }
}

/** `npub1…` or `npub1….admin` -> the npub. */
export function npubFromNccHost(hostname: string): string | null {
  return validNpub(hostname.trim().toLowerCase().split('.')[0] ?? '');
}

/** Best-effort identity from an ncc:// document address. */
export function npubFromLocation(): string | null {
  if (typeof window === 'undefined') return null;
  if (window.location.protocol !== 'ncc:') return null;
  return npubFromNccHost(window.location.hostname);
}

/** Read `npub` (bech32) or `pubkey` (hex) from a config object. */
export function npubFromConfigRecord(record: Record<string, unknown>): string | null {
  if (typeof record.npub === 'string') {
    const npub = validNpub(record.npub);
    if (npub) return npub;
  }

  if (typeof record.pubkey === 'string' && PUBKEY_PATTERN.test(record.pubkey)) {
    return nip19.npubEncode(record.pubkey.toLowerCase());
  }

  return null;
}
