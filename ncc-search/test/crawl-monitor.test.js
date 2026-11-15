import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCrawlMonitor } from '../src/crawlMonitor.js';

test('crawl monitor reports aggregate relay health without exposing relay addresses', () => {
  const monitor = createCrawlMonitor();
  monitor.connecting('articles', 'wss://private-relay.example');
  monitor.eose('articles', 'wss://private-relay.example');
  monitor.failed('articles', 'wss://another-private-relay.example');
  monitor.processingFailed('articles');

  const status = monitor.snapshot().articles;
  assert.equal(status.relayCount, 2);
  assert.equal(status.connectedRelays, 1);
  assert.equal(status.failedRelays, 1);
  assert.equal(status.processingFailureCount, 1);
  assert.equal(status.state, 'degraded');
  assert.equal(JSON.stringify(monitor.snapshot()).includes('private-relay'), false);
});
