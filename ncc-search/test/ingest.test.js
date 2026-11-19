import { test } from 'node:test';
import assert from 'node:assert/strict';

import { routeEventToCrawlers } from '../src/ingest.js';
import { KIND_CALENDAR_TIME } from '../src/adapters/calendar.js';
import { KIND_LIVE_STREAM } from '../src/adapters/live.js';
import { KIND_VIDEO_SHORT } from '../src/adapters/media.js';

function recorder() {
  const calls = [];
  return {
    calls,
    ingestEvent: (event) => calls.push(['event', event.kind]),
    ingestLiveStream: (event) => calls.push(['live', event.kind]),
    ingestMedia: (event) => calls.push(['media', event.kind]),
  };
}

const event = (kind) => ({ kind, pubkey: 'a'.repeat(64), created_at: 0, tags: [], content: '' });

test('calendar events route to the content crawler', () => {
  const contentCrawler = recorder();
  assert.equal(routeEventToCrawlers({ contentCrawler }, event(KIND_CALENDAR_TIME)), true);
  assert.deepEqual(contentCrawler.calls, [['event', KIND_CALENDAR_TIME]]);
});

test('live streams route to the content crawler', () => {
  const contentCrawler = recorder();
  assert.equal(routeEventToCrawlers({ contentCrawler }, event(KIND_LIVE_STREAM)), true);
  assert.deepEqual(contentCrawler.calls, [['live', KIND_LIVE_STREAM]]);
});

test('short videos still route to the media ingest path', () => {
  const contentCrawler = recorder();
  assert.equal(routeEventToCrawlers({ contentCrawler }, event(KIND_VIDEO_SHORT)), true);
  assert.deepEqual(contentCrawler.calls, [['media', KIND_VIDEO_SHORT]]);
});

test('a content crawler without the new ingest methods refuses the event', () => {
  const contentCrawler = { ingestArticle() {}, ingestMedia() {} };
  assert.equal(routeEventToCrawlers({ contentCrawler }, event(KIND_CALENDAR_TIME)), false);
  assert.equal(routeEventToCrawlers({ contentCrawler }, event(KIND_LIVE_STREAM)), false);
});
