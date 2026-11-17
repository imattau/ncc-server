import { test } from 'vitest';
import assert from 'node:assert/strict';

import { DEFAULT_SETTINGS, deriveMaxRows, normalizeSettings, parseRelayInput } from './settings';

const MB = 1024 * 1024;

test('the index limit is kept, and the record cap follows it', () => {
  const settings = normalizeSettings({ maxBytes: 10 * MB });
  assert.equal(settings.maxBytes, 10 * MB);
  assert.equal(settings.maxRows, 5_120);
  assert.equal(settings.maxRows, deriveMaxRows(10 * MB));
});

test('an absurd limit is clamped rather than trusted', () => {
  assert.equal(normalizeSettings({ maxBytes: 1 }).maxBytes, 5 * MB, 'below the floor');
  assert.equal(normalizeSettings({ maxBytes: 999 * MB }).maxBytes, 250 * MB, 'above the ceiling');
  assert.equal(normalizeSettings({ maxBytes: Number.NaN }).maxBytes, DEFAULT_SETTINGS.maxBytes);
  assert.equal(normalizeSettings({}).maxBytes, DEFAULT_SETTINGS.maxBytes);
});

test('a stored record cap cannot disagree with the chosen size', () => {
  // An older build (or a hand-edited localStorage value) could have both.
  const settings = normalizeSettings({ maxBytes: 25 * MB, maxRows: 60_000 });
  assert.equal(settings.maxRows, deriveMaxRows(25 * MB));
  assert.notEqual(settings.maxRows, 60_000);
});

test('relays are validated, deduplicated and capped at six', () => {
  assert.deepEqual(
    parseRelayInput('wss://a.example, wss://b.example\nwss://a.example/  https://nope.example ws://c.example'),
    ['wss://a.example', 'wss://b.example', 'ws://c.example'],
  );
  assert.equal(parseRelayInput(Array.from({ length: 10 }, (_, i) => `wss://r${i}.example`).join(',')).length, 6);
  assert.deepEqual(parseRelayInput('nonsense'), []);
  assert.deepEqual(normalizeSettings({ relays: [] }).relays, DEFAULT_SETTINGS.relays);
});

test('depth is clamped to the range the crawl loop supports', () => {
  assert.equal(normalizeSettings({ depth: 0 }).depth, 1);
  assert.equal(normalizeSettings({ depth: 99 }).depth, 10);
  assert.equal(normalizeSettings({ depth: 2.6 }).depth, 3);
  assert.equal(normalizeSettings({ depth: Number.NaN }).depth, DEFAULT_SETTINGS.depth);
});
