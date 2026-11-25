// The transport key a resolved endpoint is pinned to: NCC-02's own `k` when the
// service record has one, otherwise the NCC-05 locator endpoint's.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { AnchoredResolver } from '../src/resolver.js';

function resolverFor({ anchor, locatorEndpoint }) {
  const resolver = new AnchoredResolver([], {});
  resolver.ncc02 = {
    resolve: async () => {
      if (!anchor) throw new Error('not found');
      return { attestationCount: 0, isRevoked: false, isPrivate: false, ...anchor };
    },
  };
  resolver.ncc05 = {
    resolve: async () =>
      locatorEndpoint ? { ttl: 60, endpoints: [{ priority: 1, ...locatorEndpoint }] } : null,
  };
  return resolver;
}

const URL_FROM_LOCATOR = 'https://service.example/';

test('a record k still applies when the locator endpoint has none', async () => {
  const resolved = await resolverFor({
    anchor: { fingerprint: 'record-key' },
    locatorEndpoint: { url: URL_FROM_LOCATOR },
  }).resolveService('a'.repeat(64), 'web');

  assert.equal(resolved.endpoint, URL_FROM_LOCATOR);
  assert.equal(resolved.fingerprint, 'record-key');
});

test('a record k takes priority over a different locator k', async () => {
  const resolved = await resolverFor({
    anchor: { fingerprint: 'record-key' },
    locatorEndpoint: { url: URL_FROM_LOCATOR, k: 'locator-key' },
  }).resolveService('a'.repeat(64), 'web');

  assert.equal(resolved.fingerprint, 'record-key');
});

test('the locator k is used when the record has none, or there is no record', async () => {
  for (const anchor of [{}, null]) {
    const resolved = await resolverFor({
      anchor,
      locatorEndpoint: { url: URL_FROM_LOCATOR, k: 'locator-key' },
    }).resolveService('a'.repeat(64), 'web');

    assert.equal(resolved.fingerprint, 'locator-key');
  }
});
