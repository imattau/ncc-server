import { describe, expect, it } from 'vitest';
import { nip19 } from 'nostr-tools';

import { nsiteHref } from './sanitize';

const PUBKEY = 'a'.repeat(64);
const NPUB = nip19.npubEncode(PUBKEY);

describe('nsiteHref', () => {
  it('uses the npub when the result carries one', () => {
    expect(nsiteHref(PUBKEY, NPUB, 'nostrhub')).toBe(`nsite://${NPUB}/nostrhub`);
  });

  it('encodes a hex pubkey when the result has no npub', () => {
    expect(nsiteHref(PUBKEY, null, 'nostrhub')).toBe(`nsite://${NPUB}/nostrhub`);
    expect(nsiteHref(PUBKEY, undefined, 'nostrhub')).toBe(`nsite://${NPUB}/nostrhub`);
  });

  it('builds a host that fits in one DNS label', () => {
    // ncc-browser's Android shell loads `<host>.<site>.nsite.localhost`,
    // and a DNS label is at most 63 characters. A 64-character hex pubkey
    // does not resolve; the npub does.
    const host = nsiteHref(PUBKEY, null, 'nostrhub')!.slice('nsite://'.length).split('/')[0];
    expect(host).toHaveLength(63);
    expect(host.startsWith('npub1')).toBe(true);
  });

  it('builds the bare origin for a root site', () => {
    expect(nsiteHref(PUBKEY, null, '_root')).toBe(`nsite://${NPUB}`);
  });

  it('returns null for a d tag that is not a valid site id', () => {
    expect(nsiteHref(PUBKEY, null, 'Not A Site')).toBeNull();
    expect(nsiteHref(PUBKEY, null, 'trailing-')).toBeNull();
  });

  it('returns null when neither a npub nor a hex pubkey is available', () => {
    expect(nsiteHref('not-a-pubkey', null, 'nostrhub')).toBeNull();
  });
});
