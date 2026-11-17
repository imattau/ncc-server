import { test } from 'vitest';
import assert from 'node:assert/strict';

import { mimeFor, sha256Hex, toBase64UrlUtf8 } from './blossom';

test('sha256Hex matches the known digest of a fixed byte string', async () => {
  const bytes = new TextEncoder().encode('abc').buffer;
  assert.equal(
    await sha256Hex(bytes),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  );
});

test('the authorization encoding is base64url (BUD-11) and survives non-ASCII', () => {
  const encoded = toBase64UrlUtf8('héllo ✓');
  assert.doesNotMatch(encoded, /[+/=]/, 'base64url without padding');
  const normalized = encoded.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  assert.equal(
    new TextDecoder().decode(Uint8Array.from(atob(padded), (c) => c.charCodeAt(0))),
    'héllo ✓',
  );
});

test('content types are inferred from the published path, not the blob store', () => {
  assert.match(mimeFor('/index.html'), /^text\/html/);
  assert.match(mimeFor('/assets/app.js'), /^text\/javascript/);
  assert.match(mimeFor('/assets/app.css'), /^text\/css/);
  assert.equal(mimeFor('/assets/logo.svg'), 'image/svg+xml');
  assert.equal(mimeFor('/assets/font.woff2'), 'font/woff2');
  assert.equal(mimeFor('/assets/unrecognised'), 'application/octet-stream');
});
