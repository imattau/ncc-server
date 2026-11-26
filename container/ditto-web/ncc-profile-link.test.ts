import { nip19 } from 'nostr-tools';
import { describe, expect, it } from 'vitest';

import { isNccBrowserContext, parseProfileWebsite } from '@/lib/nccProfileLink';
import { NSITE_NAMED_KIND, NSITE_ROOT_KIND, hexToBase36 } from '@/lib/nsiteSubdomain';

const PUBKEY = '11'.repeat(32);
const NPUB = nip19.npubEncode(PUBKEY);
const BASE36 = hexToBase36(PUBKEY);
const SNAPSHOT_ID = '22'.repeat(32);

function shortened(npub: string): string {
  return `${npub.slice(0, 12)}…${npub.slice(-4)}`;
}

describe('parseProfileWebsite', () => {
  it('keeps an https URL', () => {
    const link = parseProfileWebsite('https://example.com/path?x=1');
    expect(link).toMatchObject({
      kind: 'web',
      href: 'https://example.com/path?x=1',
      label: 'example.com/path?x=1',
    });
  });

  it('normalises a bare hostname to https', () => {
    expect(parseProfileWebsite('example.com')).toMatchObject({
      kind: 'web',
      href: 'https://example.com/',
      label: 'example.com',
    });
  });

  it('rejects unsupported and unsafe web schemes', () => {
    expect(parseProfileWebsite('http://example.com')).toBeUndefined();
    expect(parseProfileWebsite('javascript:alert(1)')).toBeUndefined();
    expect(parseProfileWebsite('javascript://example.com/%0aalert(1)')).toBeUndefined();
  });

  it('accepts an ncc service address', () => {
    expect(parseProfileWebsite(`ncc://${NPUB}/web`)).toMatchObject({
      kind: 'ncc',
      href: `ncc://${NPUB}/web`,
      label: `ncc://${shortened(NPUB)}/web`,
      faviconUrl: null,
    });
  });

  it('accepts a bare ncc identity as the default service', () => {
    expect(parseProfileWebsite(`ncc://${PUBKEY}`)).toMatchObject({
      kind: 'ncc',
      href: `ncc://${NPUB}/`,
      label: `ncc://${shortened(NPUB)}`,
    });
  });

  it('preserves an explicit ncc service path', () => {
    expect(parseProfileWebsite(`ncc://${NPUB}/addr/foo?x=1`)).toMatchObject({
      kind: 'ncc',
      href: `ncc://${NPUB}/addr/foo?x=1`,
      label: `ncc://${shortened(NPUB)}/addr`,
    });
  });

  it('rejects a non-nostr ncc host or an invalid service name', () => {
    expect(parseProfileWebsite('ncc://example.com/web')).toBeUndefined();
    expect(parseProfileWebsite(`ncc://${NPUB}/web%2Fevil`)).toBeUndefined();
  });

  it('accepts a root nsite', () => {
    expect(parseProfileWebsite(`nsite://${NPUB}`)).toMatchObject({
      kind: 'nsite',
      href: `nsite://${NPUB}/`,
      route: `/${nip19.naddrEncode({ kind: NSITE_ROOT_KIND, pubkey: PUBKEY, identifier: '' })}`,
      label: `nsite://${shortened(NPUB)}`,
      faviconUrl: `https://${NPUB}.nsite.lol`,
    });
  });

  it('accepts an nsite named site in the npub/path form', () => {
    expect(parseProfileWebsite(`nsite://${NPUB}/blog`)).toMatchObject({
      kind: 'nsite',
      href: `nsite://${NPUB}/blog/`,
      route: `/${nip19.naddrEncode({ kind: NSITE_NAMED_KIND, pubkey: PUBKEY, identifier: 'blog' })}`,
      label: `nsite://${shortened(NPUB)}/blog`,
      faviconUrl: `https://${BASE36}blog.nsite.lol`,
    });
  });

  it('preserves an nsite deep path in the native address', () => {
    expect(parseProfileWebsite(`nsite://${NPUB}/blog/about`)).toMatchObject({
      kind: 'nsite',
      href: `nsite://${NPUB}/blog/about`,
    });
  });

  it('accepts the NIP-5A host form for a named site', () => {
    expect(parseProfileWebsite(`nsite://${BASE36}blog`)).toMatchObject({
      kind: 'nsite',
      href: `nsite://${NPUB}/blog/`,
      route: `/${nip19.naddrEncode({ kind: NSITE_NAMED_KIND, pubkey: PUBKEY, identifier: 'blog' })}`,
    });
  });

  it('accepts a snapshot', () => {
    const base36 = hexToBase36(SNAPSHOT_ID);
    expect(parseProfileWebsite(`nsite://v${base36}`)).toMatchObject({
      kind: 'nsite',
      href: `nsite://v${base36}/`,
      route: `/${nip19.neventEncode({ id: SNAPSHOT_ID })}`,
      label: 'nsite://snapshot',
      nativeNcc: false,
    });
  });

  it('rejects an nsite with an unknown host', () => {
    expect(parseProfileWebsite('nsite://example.com')).toBeUndefined();
  });
});

describe('isNccBrowserContext', () => {
  const ANDROID_UA =
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) ' +
    'Chrome/131.0.0.0 Mobile Safari/537.36 NostrNavigator/0.47.19';
  const DESKTOP_UA =
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
    'Chrome/131.0.0.0 Safari/537.36';

  it('detects the desktop ncc protocol', () => {
    expect(isNccBrowserContext('ncc:', 'abc.ditto', DESKTOP_UA)).toBe(true);
  });

  it('detects the mobile loopback proxy', () => {
    expect(isNccBrowserContext('http:', 'npub.ditto.localhost', DESKTOP_UA)).toBe(true);
  });

  it('detects the mobile user agent over an ordinary https origin', () => {
    expect(isNccBrowserContext('https:', 'ditto.example.com', ANDROID_UA)).toBe(true);
  });

  it('ignores ordinary browsers', () => {
    expect(isNccBrowserContext('https:', 'ditto.example.com', DESKTOP_UA)).toBe(false);
    expect(isNccBrowserContext('http:', 'localhost', DESKTOP_UA)).toBe(false);
  });
});
