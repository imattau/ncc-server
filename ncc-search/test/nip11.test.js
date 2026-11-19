import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import https from 'node:https';
import { fetchRelayInfo, Nip11Prober } from '../src/nip11.js';

let hasOpenssl = true;
try {
  execFileSync('openssl', ['version'], { stdio: 'ignore' });
} catch {
  hasOpenssl = false;
}

let server;
let port;
let tmpDir;
let requestCount = 0;
/** @type {Record<string, unknown>} */
let infoByPath = {};

before(async () => {
  if (!hasOpenssl) return;

  tmpDir = mkdtempSync(join(tmpdir(), 'ncc-search-nip11-test-'));
  const keyPath = join(tmpDir, 'key.pem');
  const certPath = join(tmpDir, 'cert.pem');
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', keyPath, '-out', certPath,
    '-days', '1', '-subj', '/CN=127.0.0.1',
  ], { stdio: 'ignore' });

  const key = readFileSync(keyPath, 'utf8');
  const cert = readFileSync(certPath, 'utf8');

  server = https.createServer({ key, cert }, (req, res) => {
    requestCount += 1;
    const info = infoByPath[req.url];
    if (!info) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/nostr+json' });
    res.end(JSON.stringify(info));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

test('fetchRelayInfo converts wss:// to https:// and parses the NIP-11 document', { skip: !hasOpenssl && 'openssl not available' }, async () => {
  infoByPath = { '/': { name: 'test relay', supported_nips: [1, 11, 50] } };
  const info = await fetchRelayInfo(`wss://127.0.0.1:${port}/`, { timeoutMs: 2000 });
  assert.equal(info.name, 'test relay');
  assert.deepEqual(info.supported_nips, [1, 11, 50]);
});

test('fetchRelayInfo returns null on 404 instead of throwing', { skip: !hasOpenssl && 'openssl not available' }, async () => {
  infoByPath = {};
  const info = await fetchRelayInfo(`wss://127.0.0.1:${port}/missing`, { timeoutMs: 2000 });
  assert.equal(info, null);
});

test('Nip11Prober.supportsNip50 reflects supported_nips', { skip: !hasOpenssl && 'openssl not available' }, async () => {
  infoByPath = { '/': { supported_nips: [1, 50] } };
  const prober = new Nip11Prober({ timeoutMs: 2000 });
  assert.equal(await prober.supportsNip50(`wss://127.0.0.1:${port}/`), true);
});

test('Nip11Prober.supportsNip50 is false when supported_nips omits 50', { skip: !hasOpenssl && 'openssl not available' }, async () => {
  infoByPath = { '/': { supported_nips: [1, 11] } };
  const prober = new Nip11Prober({ timeoutMs: 2000 });
  assert.equal(await prober.supportsNip50(`wss://127.0.0.1:${port}/`), false);
});

test('Nip11Prober caches a relay check instead of re-fetching', { skip: !hasOpenssl && 'openssl not available' }, async () => {
  infoByPath = { '/cached': { supported_nips: [50] } };
  const prober = new Nip11Prober({ timeoutMs: 2000, cacheTtlMs: 60_000 });
  const url = `wss://127.0.0.1:${port}/cached`;

  const before_ = requestCount;
  await prober.supportsNip50(url);
  const afterFirst = requestCount;
  await prober.supportsNip50(url);
  const afterSecond = requestCount;

  assert.equal(afterFirst, before_ + 1);
  assert.equal(afterSecond, afterFirst, 'second call should be served from cache');
});

test('Nip11Prober.filterCapable returns only the relays that advertise NIP-50', { skip: !hasOpenssl && 'openssl not available' }, async () => {
  infoByPath = {
    '/yes': { supported_nips: [50] },
    '/no': { supported_nips: [1] },
  };
  const prober = new Nip11Prober({ timeoutMs: 2000 });
  const capable = await prober.filterCapable([
    `wss://127.0.0.1:${port}/yes`,
    `wss://127.0.0.1:${port}/no`,
    `wss://127.0.0.1:${port}/unreachable-path-that-404s`,
  ]);
  assert.deepEqual(capable, [`wss://127.0.0.1:${port}/yes`]);
});

test('Nip11Prober bounds its cache, evicting the least-recently-used relay', { skip: !hasOpenssl && 'openssl not available' }, async () => {
  const prober = new Nip11Prober({ timeoutMs: 2000, maxEntries: 2 });
  prober.cache.set('wss://a.example/', { supported: true, checkedAt: Date.now() });
  prober.cache.set('wss://b.example/', { supported: true, checkedAt: Date.now() });

  // Touch `a`, making `b` the least recently used entry.
  assert.equal(await prober.supportsNip50('wss://a.example/'), true);
  infoByPath = { '/new': { supported_nips: [50] } };
  await prober.supportsNip50(`wss://127.0.0.1:${port}/new`);

  assert.equal(prober.cache.size, 2);
  assert.equal(prober.cache.has('wss://a.example/'), true);
  assert.equal(prober.cache.has('wss://b.example/'), false);
});
