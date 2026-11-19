import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseClientRelays } from '../src/clientRelays.js';

test('accepts public wss relays and dedupes them', () => {
  assert.deepEqual(
    parseClientRelays('wss://relay.example,wss://relay.example, wss://other.example'),
    ['wss://relay.example/', 'wss://other.example/'],
  );
});

test('accepts the repeated query-param form', () => {
  assert.deepEqual(
    parseClientRelays(['wss://a.example', 'wss://b.example']),
    ['wss://a.example/', 'wss://b.example/'],
  );
});

test('caps the list at the configured maximum', () => {
  const value = Array.from({ length: 10 }, (_, i) => `wss://r${i}.example`).join(',');
  assert.equal(parseClientRelays(value, { max: 3 }).length, 3);
  assert.equal(parseClientRelays(value).length, 3, 'default max is 3');
});

test('rejects non-wss, credentials, fragments and local/private hosts', () => {
  const bad = [
    'ws://relay.example',
    'https://relay.example',
    'wss://user:pass@relay.example',
    'wss://relay.example/#hash',
    'wss://localhost',
    'wss://relay.localhost',
    'wss://printer.local',
    'wss://relay.onion',
    'wss://127.0.0.1',
    'wss://10.1.2.3',
    'wss://172.16.0.1',
    'wss://192.168.1.4',
    'wss://169.254.169.254',
    'wss://[::1]',
    'not a url',
  ];
  assert.deepEqual(parseClientRelays(bad.join(',')), []);
});

test('ignores malformed entries without rejecting the valid ones', () => {
  assert.deepEqual(
    parseClientRelays('nonsense, wss://good.example, ws://bad.example'),
    ['wss://good.example/'],
  );
});

test('an empty or missing value is an empty list', () => {
  assert.deepEqual(parseClientRelays(undefined), []);
  assert.deepEqual(parseClientRelays(''), []);
  assert.deepEqual(parseClientRelays([]), []);
});
