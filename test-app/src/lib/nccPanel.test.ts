import { describe, expect, it } from 'vitest';
import type { NostrEvent } from 'nostr-tools';

import { buildPanelSnapshot } from './nccPanel';

const NOW = Math.floor(Date.now() / 1000);

function event(overrides: Partial<NostrEvent>): NostrEvent {
  return {
    id: 'a'.repeat(64),
    pubkey: 'b'.repeat(64),
    created_at: NOW - 60,
    kind: 30059,
    tags: [],
    content: '',
    sig: 'c'.repeat(128),
    ...overrides,
  };
}

const report = {
  url: 'wss://relay.example/',
  connected: true,
  anchorCount: 1,
  locatorCount: 1,
};

describe('buildPanelSnapshot', () => {
  it('joins an anchor and its locator into a published service', () => {
    const anchor = event({
      kind: 30059,
      tags: [['d', 'web'], ['u', 'https://example.com:8443/'], ['k', 'pin']],
    });
    const locator = event({
      id: 'd'.repeat(64),
      kind: 30058,
      tags: [['d', 'web-locator'], ['expiration', String(NOW + 3600)]],
      content: JSON.stringify({
        ttl: 43200,
        updated_at: NOW - 30,
        endpoints: [{ url: 'https://example.com:8443/', k: 'pin' }],
      }),
    });

    const snapshot = buildPanelSnapshot([anchor, locator], [report]);

    expect(snapshot.services).toHaveLength(1);
    expect(snapshot.services[0]).toMatchObject({
      id: 'web',
      endpoint: 'https://example.com:8443/',
      pin: 'pin',
      ttlSeconds: 43200,
      status: 'published',
    });
    expect(snapshot.activity.map((item) => item.kind).sort()).toEqual([30058, 30059]);
    expect(snapshot.relays).toEqual([report]);
  });

  it('marks a service with only an anchor as anchor-only', () => {
    const snapshot = buildPanelSnapshot([
      event({ tags: [['d', 'relay'], ['u', 'wss://relay.example:8444/relay/']] }),
    ], []);

    expect(snapshot.services).toHaveLength(1);
    expect(snapshot.services[0].id).toBe('relay');
    expect(snapshot.services[0].status).toBe('anchor-only');
    expect(snapshot.services[0].endpoint).toBe('wss://relay.example:8444/relay/');
  });

  it('marks an encrypted locator as private and hides its endpoint', () => {
    const anchor = event({
      kind: 30059,
      tags: [['d', 'admin'], ['private', 'true'], ['k', 'pin']],
    });
    const locator = event({
      id: 'e'.repeat(64),
      kind: 30058,
      tags: [['d', 'admin-locator'], ['private', 'true']],
      content: 'nip44-ciphertext-that-is-not-json',
    });

    const snapshot = buildPanelSnapshot([anchor, locator], [report]);

    expect(snapshot.services).toHaveLength(1);
    expect(snapshot.services[0]).toMatchObject({
      id: 'admin',
      endpoint: null,
      pin: 'pin',
      private: true,
      status: 'private',
    });
  });

  it('marks a service with only a locator as locator-only', () => {
    const snapshot = buildPanelSnapshot([
      event({
        kind: 30058,
        tags: [['d', 'admin-locator'], ['expiration', String(NOW + 3600)]],
        content: JSON.stringify({ endpoints: [{ url: 'https://example.com:8448/', k: null }] }),
      }),
    ], []);

    expect(snapshot.services).toHaveLength(1);
    expect(snapshot.services[0].id).toBe('admin');
    expect(snapshot.services[0].status).toBe('locator-only');
    expect(snapshot.services[0].endpoint).toBe('https://example.com:8448/');
  });

  it('keeps the newest event when a relay returns duplicates', () => {
    const older = event({ id: '1'.repeat(64), created_at: NOW - 120, tags: [['d', 'web'], ['u', 'https://old.example/']] });
    const newer = event({ id: '2'.repeat(64), created_at: NOW - 30, tags: [['d', 'web'], ['u', 'https://new.example/']] });

    const snapshot = buildPanelSnapshot([older, newer], []);

    expect(snapshot.services).toHaveLength(1);
    expect(snapshot.services[0].endpoint).toBe('https://new.example/');
    expect(snapshot.latestPublishedAt).toBe(NOW - 30);
  });
});
