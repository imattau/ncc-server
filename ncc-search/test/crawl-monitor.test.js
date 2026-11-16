import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCrawlMonitor } from '../src/crawlMonitor.js';
import { classifyNsiteError } from '../src/adapters/nsite-crawl.js';

test('one dead relay is degraded for diagnostics but not incomplete', () => {
  const monitor = createCrawlMonitor();
  monitor.connecting('articles', 'wss://good.example');
  monitor.eose('articles', 'wss://good.example');
  monitor.failed('articles', 'wss://dead.example', ['connection failed:\nHTTP 521']);
  monitor.processingFailed('articles');

  const status = monitor.snapshot().articles;
  assert.equal(status.relayCount, 2);
  assert.equal(status.connectedRelays, 1);
  assert.equal(status.failedRelays, 1);
  assert.equal(status.processingFailureCount, 1);
  assert.equal(status.state, 'degraded');
  assert.equal(status.incomplete, false);
  assert.equal(status.stale, false);
});

test('status names each relay with its state, failure count and sanitized last error', () => {
  const monitor = createCrawlMonitor();
  monitor.eose('media', 'wss://good.example');
  monitor.failed('media', 'wss://dead.example', ['x'.repeat(500) + '\u0007']);
  monitor.failed('media', 'wss://dead.example', new Error('boom\nline2'));
  const relays = monitor.snapshot().media.relays;
  const dead = relays.find((r) => r.url === 'wss://dead.example');
  assert.equal(dead.connected, false);
  assert.equal(dead.failureCount, 2);
  assert.equal(dead.consecutiveFailures, 2);
  assert.equal(dead.lastError, 'boom line2');
  assert.equal(relays.find((r) => r.url === 'wss://good.example').connected, true);
  monitor.failed('media', 'wss://dead.example', ['y'.repeat(500)]);
  assert.equal(monitor.snapshot().media.relays[1].lastError.length, 200);
});

test('non-string close reasons are described, never "[object Object]"', () => {
  const monitor = createCrawlMonitor();
  monitor.failed('media', 'wss://a.example', [{ type: 'error' }]);
  monitor.failed('media', 'wss://b.example', [{ message: 'connection refused' }]);
  const [a, b] = monitor.snapshot().media.relays;
  assert.equal(a.lastError, 'error');
  assert.equal(b.lastError, 'connection refused');
});

test('all relays down is unavailable and incomplete', () => {
  const monitor = createCrawlMonitor();
  monitor.failed('nsites', 'wss://a.example');
  monitor.failed('nsites', 'wss://b.example');
  const status = monitor.snapshot().nsites;
  assert.equal(status.state, 'unavailable');
  assert.equal(status.incomplete, true);
});

test('no sync within the stale threshold is incomplete even while relays are not connected', () => {
  let t = 1_000_000;
  const monitor = createCrawlMonitor({ staleAfterMs: 60_000, now: () => t });
  monitor.eose('articles', 'wss://a.example');
  monitor.failed('articles', 'wss://b.example');
  assert.equal(monitor.snapshot().articles.incomplete, false);
  // starting forever (a relay stuck connecting, never synced)
  monitor.connecting('media', 'wss://c.example');
  assert.equal(monitor.snapshot().media.incomplete, false);
  t += 61_000;
  assert.equal(monitor.snapshot().media.stale, true);
  assert.equal(monitor.snapshot().media.incomplete, true);
  // a live connection stays fresh without a new EOSE
  assert.equal(monitor.snapshot().articles.incomplete, false);
});

test('processing failures are bucketed by reason', () => {
  const monitor = createCrawlMonitor();
  monitor.processingFailed('nsites', 'no-blossom-servers');
  monitor.processingFailed('nsites', 'no-blossom-servers');
  monitor.processingFailed('nsites', 'sha256-mismatch');
  const status = monitor.snapshot().nsites;
  assert.equal(status.processingFailureCount, 3);
  assert.deepEqual(status.processingFailureReasons, { 'no-blossom-servers': 2, 'sha256-mismatch': 1 });
  assert.equal(classifyNsiteError('https://x: HTTP 404'), 'blossom-http-error');
  assert.equal(classifyNsiteError('no Blossom servers (no `server` tags)'), 'no-blossom-servers');
  assert.equal(classifyNsiteError('manifest has no usable entry path'), 'manifest-no-entry-path');
});
