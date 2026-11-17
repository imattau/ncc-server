import { test } from 'vitest';
import assert from 'node:assert/strict';
import { finalizeEvent, generateSecretKey, getPublicKey, nip19, verifyEvent } from 'nostr-tools';

import {
  nsiteAddress,
  signManifest,
  validateFiles,
  validateSiteId,
  type SiteFile,
} from './manifest';
import type { Nip07Signer } from './nip07';

function localSigner(): Nip07Signer {
  const secret = generateSecretKey();
  return {
    async getPublicKey() {
      return getPublicKey(secret);
    },
    async signEvent(template) {
      return finalizeEvent(template, secret);
    },
  };
}

function siteFile(path: string, size = 10): SiteFile {
  return {
    path,
    hash: 'a'.repeat(64),
    size,
    file: new File([new Uint8Array(size)], path.replace(/^\//, '')),
  };
}

test('site ids follow the client grammar exactly', () => {
  assert.equal(validateSiteId('nccsearch'), null);
  assert.equal(validateSiteId('a-b-1'), null);
  assert.match(validateSiteId('has space') ?? '', /1-13 characters/);
  assert.match(validateSiteId('fourteen-chars') ?? '', /1-13 characters/);
  assert.match(validateSiteId('trailing-') ?? '', /cannot end with a dash/);
  assert.notEqual(validateSiteId('UPPER'), null);
});

test('a folder is rejected unless it looks like a built site', () => {
  assert.deepEqual(validateFiles([]), ['Choose the built site folder first.']);

  const problems = validateFiles([siteFile('/assets/app.js')]);
  assert.match(problems.join(' '), /no \/index\.html/);

  assert.deepEqual(validateFiles([siteFile('/index.html'), siteFile('/assets/app.js')]), []);

  const traversal = validateFiles([siteFile('/index.html'), siteFile('/../secret')]);
  assert.match(traversal.join(' '), /illegal path segment/);

  const duplicate = validateFiles([siteFile('/index.html'), siteFile('/index.html')]);
  assert.match(duplicate.join(' '), /appears twice/);
});

test('the manifest names every path and only the servers that hold the files', async () => {
  const signer = localSigner();
  const event = await signManifest({
    siteId: 'nccsearch',
    title: 'nccsearch',
    description: 'local index',
    source: 'https://example.com/repo',
    files: [siteFile('/index.html'), siteFile('/assets/app.js')],
    servers: ['https://blossom.example/', 'https://nostr.download'],
    signer,
  });

  assert.equal(event.kind, 35128);
  assert.equal(event.content, '');
  assert.ok(verifyEvent(event));
  assert.deepEqual(event.tags.find((tag) => tag[0] === 'd'), ['d', 'nccsearch']);
  assert.deepEqual(
    event.tags.filter((tag) => tag[0] === 'path'),
    [
      ['path', '/index.html', 'a'.repeat(64)],
      ['path', '/assets/app.js', 'a'.repeat(64)],
    ],
  );
  assert.deepEqual(
    event.tags.filter((tag) => tag[0] === 'server').map((tag) => tag[1]),
    ['https://blossom.example', 'https://nostr.download'],
    'trailing slashes are stripped so blob URLs never double up',
  );
  assert.equal(event.tags.find((tag) => tag[0] === 'title')?.[1], 'nccsearch');
});

test('an invalid signer signature is refused before publishing', async () => {
  const signer: Nip07Signer = {
    async getPublicKey() {
      return 'b'.repeat(64);
    },
    async signEvent(template) {
      return { ...template, id: 'c'.repeat(64), pubkey: 'b'.repeat(64), sig: 'd'.repeat(128) };
    },
  };
  await assert.rejects(
    signManifest({
      siteId: 'nccsearch',
      title: '',
      description: '',
      source: '',
      files: [siteFile('/index.html')],
      servers: ['https://blossom.example'],
      signer,
    }),
    /invalid manifest signature/,
  );
});

test('the address is the origin-scoped nsite form', async () => {
  const signer = localSigner();
  const pubkey = await signer.getPublicKey();
  assert.equal(nsiteAddress(pubkey, 'nccsearch'), `nsite://${nip19.npubEncode(pubkey)}/nccsearch`);
});
