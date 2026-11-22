import { test } from 'node:test';
import assert from 'node:assert/strict';

import { KIND_APP, resolveApp } from '../src/adapters/app.js';

function appEvent(overrides = {}) {
  return {
    id: 'f'.repeat(64),
    pubkey: 'a'.repeat(64),
    kind: KIND_APP,
    created_at: 1_700_000_000,
    content: 'A **private** app store for Android.',
    tags: [
      ['d', 'dev.zapstore.app'],
      ['name', 'Zapstore'],
      ['summary', 'The private app store'],
      ['icon', 'https://cdn.example.com/icon.png'],
      ['image', 'https://cdn.example.com/shot1.png'],
      ['f', 'android-arm64-v8a'],
      ['t', 'Android'],
      ['t', 'nostr'],
      ['url', 'https://zapstore.dev'],
      ['repository', 'https://github.com/zapstore/zapstore'],
    ],
    ...overrides,
  };
}

test('an app listing maps its name, summary, icon, platforms and store link', () => {
  const resolved = resolveApp(appEvent());
  assert.ok(resolved);
  assert.equal(resolved.kind, 'app');
  assert.equal(resolved.itemId, 'dev.zapstore.app');
  assert.equal(resolved.title, 'Zapstore');
  assert.equal(resolved.description, 'The private app store');
  assert.equal(resolved.body, 'A private app store for Android.');
  assert.equal(resolved.thumbnailUrl, 'https://cdn.example.com/icon.png');
  assert.equal(resolved.endpoint, 'https://zapstore.dev/apps/dev.zapstore.app');
  assert.deepEqual(resolved.platforms, ['android-arm64-v8a']);
  assert.deepEqual(resolved.hashtags, ['android', 'nostr']);
  assert.equal(resolved.postedAt, 1_700_000_000);
});

test('the store link percent-encodes an app id', () => {
  const resolved = resolveApp(appEvent({ tags: [['d', 'com.example/my app'], ['name', 'Example']] }));
  assert.equal(resolved.endpoint, 'https://zapstore.dev/apps/com.example%2Fmy%20app');
});

test('an app with no platforms or icon still resolves', () => {
  const resolved = resolveApp(appEvent({ tags: [['d', 'example.app'], ['name', 'Example']] }));
  assert.equal(resolved.platforms, null);
  assert.equal(resolved.thumbnailUrl, null);
  assert.equal(resolved.description, null);
  assert.equal(resolved.body, 'A private app store for Android.');
});

test('an app with no d tag or no name is skipped', () => {
  assert.equal(resolveApp(appEvent({ tags: [['name', 'No identity']] })), null);
  assert.equal(resolveApp(appEvent({ tags: [['d', 'example.app']] })), null);
});
