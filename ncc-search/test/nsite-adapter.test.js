import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SimplePool } from 'nostr-tools';
import {
  KIND_ROOT_SITE,
  KIND_NAMED_SITE,
  parseManifest,
  pickEntryPath,
  resolveNip05,
  NsiteAdapter,
} from '../src/adapters/nsite.js';

function sha256hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function manifestEvent({ kind, dTag, paths, servers = [], title, description }) {
  const tags = [];
  if (dTag) tags.push(['d', dTag]);
  for (const [path, hash] of paths) tags.push(['path', path, hash]);
  for (const server of servers) tags.push(['server', server]);
  if (title) tags.push(['title', title]);
  if (description) tags.push(['description', description]);
  return {
    kind,
    pubkey: 'f'.repeat(64),
    tags,
    content: '',
    created_at: Math.floor(Date.now() / 1000),
  };
}

test('parseManifest extracts path map, server hints, title, description', () => {
  const html = Buffer.from('<html><title>Hi</title></html>');
  const event = manifestEvent({
    kind: KIND_NAMED_SITE,
    dTag: 'blog',
    paths: [['/index.html', sha256hex(html)], ['/404.html', 'deadbeef']],
    servers: ['https://blossom.example'],
    title: 'My Blog',
    description: 'Thoughts',
  });

  const manifest = parseManifest(event);
  assert.equal(manifest.paths.get('/index.html'), sha256hex(html));
  assert.deepEqual(manifest.servers, ['https://blossom.example']);
  assert.equal(manifest.title, 'My Blog');
  assert.equal(manifest.description, 'Thoughts');
});

test('pickEntryPath prefers /index.html, falls back to any html path, then first path', () => {
  assert.equal(pickEntryPath(new Map([['/index.html', 'a'], ['/about.html', 'b']])), '/index.html');
  assert.equal(pickEntryPath(new Map([['/about.html', 'b'], ['/style.css', 'c']])), '/about.html');
  assert.equal(pickEntryPath(new Map([['/style.css', 'c']])), '/style.css');
  assert.equal(pickEntryPath(new Map()), null);
});

test('NsiteAdapter.resolveSite: root site uses siteId "_root", named site uses its d tag', () => {
  const pool = new SimplePool();
  const adapter = new NsiteAdapter(pool, [], { fetchTimeoutMs: 1000, fetchMaxBytes: 1000, torSocks: '' });

  const root = manifestEvent({ kind: KIND_ROOT_SITE, paths: [['/index.html', 'abc']] });
  const named = manifestEvent({ kind: KIND_NAMED_SITE, dTag: 'blog', paths: [['/index.html', 'abc']] });

  assert.equal(adapter.resolveSite(root).siteId, '_root');
  assert.equal(adapter.resolveSite(named).siteId, 'blog');
  assert.equal(adapter.resolveSite(named).entrySha256, 'abc');
});

test('NsiteAdapter.fetchAndExtract fails closed on a sha256 mismatch (Blossom integrity check)', async () => {
  const html = Buffer.from('<html><title>Real content</title></html>');
  const wrongHash = sha256hex(Buffer.from('not the real content'));

  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(html);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  const pool = new SimplePool();
  const adapter = new NsiteAdapter(pool, [], {
    fetchTimeoutMs: 2000,
    fetchMaxBytes: 1_000_000,
    torSocks: '',
  });

  const event = manifestEvent({
    kind: KIND_NAMED_SITE,
    dTag: 'blog',
    paths: [['/index.html', wrongHash]],
    servers: [`http://127.0.0.1:${port}`],
  });

  const resolved = adapter.resolveSite(event);
  const result = await adapter.fetchAndExtract(resolved);

  assert.match(result.error, /sha256 mismatch/);
  assert.equal(result.title, undefined);

  await new Promise((resolve) => server.close(resolve));
});

test('NsiteAdapter.fetchAndExtract succeeds and extracts content when the hash matches', async () => {
  const html = Buffer.from('<html><head><title>Real content</title></head><body>Hello world</body></html>');
  const correctHash = sha256hex(html);

  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(html);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  const pool = new SimplePool();
  const adapter = new NsiteAdapter(pool, [], {
    fetchTimeoutMs: 2000,
    fetchMaxBytes: 1_000_000,
    torSocks: '',
  });

  const event = manifestEvent({
    kind: KIND_NAMED_SITE,
    dTag: 'blog',
    paths: [['/index.html', correctHash]],
    servers: [`http://127.0.0.1:${port}`],
  });

  const resolved = adapter.resolveSite(event);
  const result = await adapter.fetchAndExtract(resolved);

  assert.equal(result.status, 200);
  assert.equal(result.title, 'Real content');
  assert.match(result.text, /Hello world/);

  await new Promise((resolve) => server.close(resolve));
});

test('NsiteAdapter.fetchAndExtract carries an absolute og:image through as the site thumbnail', async () => {
  const html = Buffer.from(
    '<html><head><title>Has a cover</title>' +
      '<meta property="og:image" content="https://cdn.example/cover.png"></head><body>hi</body></html>',
  );
  const correctHash = sha256hex(html);

  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(html);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  const pool = new SimplePool();
  const adapter = new NsiteAdapter(pool, [], {
    fetchTimeoutMs: 2000,
    fetchMaxBytes: 1_000_000,
    torSocks: '',
  });

  const event = manifestEvent({
    kind: KIND_NAMED_SITE,
    dTag: 'blog',
    paths: [['/index.html', correctHash]],
    servers: [`http://127.0.0.1:${port}`],
  });

  const result = await adapter.fetchAndExtract(adapter.resolveSite(event));
  assert.equal(result.image, 'https://cdn.example/cover.png');

  await new Promise((resolve) => server.close(resolve));
});

test('NsiteAdapter.fetchAndExtract drops a page-relative og:image -- there is no site domain to resolve it against', async () => {
  const html = Buffer.from(
    '<html><head><title>Relative cover</title>' +
      '<meta property="og:image" content="/cover.png"></head><body>hi</body></html>',
  );
  const correctHash = sha256hex(html);

  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(html);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  const pool = new SimplePool();
  const adapter = new NsiteAdapter(pool, [], {
    fetchTimeoutMs: 2000,
    fetchMaxBytes: 1_000_000,
    torSocks: '',
  });

  const event = manifestEvent({
    kind: KIND_NAMED_SITE,
    dTag: 'blog',
    paths: [['/index.html', correctHash]],
    servers: [`http://127.0.0.1:${port}`],
  });

  const result = await adapter.fetchAndExtract(adapter.resolveSite(event));
  assert.equal(result.image, null);

  await new Promise((resolve) => server.close(resolve));
});

// --- NIP-05 verification ---

const NIP05_PUBKEY = 'a'.repeat(64);
let nip05Server;
let nip05Port;
let nip05TmpDir;

// NIP-05 verification is specified as HTTPS-only ("Clients MUST fetch
// https://<domain>/.well-known/nostr.json"), so the mock has to be a real
// TLS server, not plain HTTP -- using a plain server here would test
// something resolveNip05() doesn't actually do.
before(async () => {
  let hasOpenssl = true;
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
  } catch {
    hasOpenssl = false;
  }
  if (!hasOpenssl) return;

  nip05TmpDir = mkdtempSync(join(tmpdir(), 'ncc-search-nip05-test-'));
  const keyPath = join(nip05TmpDir, 'key.pem');
  const certPath = join(nip05TmpDir, 'cert.pem');
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', keyPath, '-out', certPath,
    '-days', '1', '-subj', '/CN=127.0.0.1',
  ], { stdio: 'ignore' });

  const key = readFileSync(keyPath, 'utf8');
  const cert = readFileSync(certPath, 'utf8');

  nip05Server = https.createServer({ key, cert }, (req, res) => {
    const url = new URL(req.url, 'https://localhost');
    if (url.pathname !== '/.well-known/nostr.json') {
      res.writeHead(404).end();
      return;
    }
    const name = url.searchParams.get('name');
    const names = {};
    if (name === 'alice') names.alice = NIP05_PUBKEY;
    if (name === '_') names._ = NIP05_PUBKEY;
    if (name === 'mallory') names.mallory = 'f'.repeat(64); // claims a different pubkey -- must not verify
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ names }));
  });
  await new Promise((resolve) => nip05Server.listen(0, '127.0.0.1', resolve));
  nip05Port = nip05Server.address().port;
});

after(async () => {
  if (nip05Server) await new Promise((resolve) => nip05Server.close(resolve));
  if (nip05TmpDir) rmSync(nip05TmpDir, { recursive: true, force: true });
});

function poolWithProfile(nip05Claim) {
  const pool = new SimplePool();
  pool.get = async () => ({
    kind: 0,
    pubkey: NIP05_PUBKEY,
    content: JSON.stringify({ name: 'Alice', nip05: nip05Claim }),
    tags: [],
  });
  return pool;
}

test('resolveNip05 verifies a matching name@domain claim', async () => {
  const pool = poolWithProfile(`alice@127.0.0.1:${nip05Port}`);
  const result = await resolveNip05(pool, [], NIP05_PUBKEY, { timeoutMs: 2000 });
  assert.equal(result, `alice@127.0.0.1:${nip05Port}`);
});

test('resolveNip05 returns null (not a guess) when the domain claims a different pubkey', async () => {
  const pool = poolWithProfile(`mallory@127.0.0.1:${nip05Port}`);
  const result = await resolveNip05(pool, [], NIP05_PUBKEY, { timeoutMs: 2000 });
  assert.equal(result, null);
});

test('resolveNip05 returns null when there is no nip05 field at all', async () => {
  const pool = new SimplePool();
  pool.get = async () => ({ kind: 0, pubkey: NIP05_PUBKEY, content: JSON.stringify({ name: 'Alice' }), tags: [] });
  const result = await resolveNip05(pool, [], NIP05_PUBKEY, { timeoutMs: 2000 });
  assert.equal(result, null);
});
