import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  KIND_CALENDAR_DATE,
  KIND_CALENDAR_TIME,
  resolveEvent,
} from '../src/adapters/calendar.js';

function event(overrides = {}) {
  return {
    id: 'e'.repeat(64),
    pubkey: 'a'.repeat(64),
    kind: KIND_CALENDAR_DATE,
    created_at: 1_700_000_000,
    content: 'A **community** meetup',
    tags: [
      ['d', 'meetup-1'],
      ['title', 'Nostr Meetup'],
      ['summary', 'Monthly gathering'],
      ['start', '2026-12-01'],
      ['end', '2026-12-02'],
      ['location', 'Berlin'],
      ['location', 'Online'],
      ['image', 'https://example.com/meetup.jpg'],
      ['r', 'https://example.com/rsvp'],
      ['t', 'Nostr'],
      ['t', 'meetup'],
    ],
    ...overrides,
  };
}

test('a date-based NIP-52 event keeps its UTC date, all-day flag and locations', () => {
  const resolved = resolveEvent(event());
  assert.ok(resolved);
  assert.equal(resolved.kind, 'event');
  assert.equal(resolved.itemId, 'meetup-1');
  assert.equal(resolved.title, 'Nostr Meetup');
  assert.equal(resolved.description, 'Monthly gathering');
  assert.equal(resolved.allDay, 1);
  assert.equal(resolved.startsAt, Date.UTC(2026, 11, 1) / 1000);
  assert.equal(resolved.endsAt, Date.UTC(2026, 11, 2) / 1000);
  assert.equal(resolved.location, 'Berlin · Online');
  assert.equal(resolved.endpoint, 'https://example.com/rsvp');
  assert.equal(resolved.thumbnailUrl, 'https://example.com/meetup.jpg');
  assert.match(resolved.body, /community meetup/);
  assert.match(resolved.body, /Berlin/);
  assert.deepEqual(resolved.hashtags, ['nostr', 'meetup']);
  assert.equal(resolved.postedAt, 1_700_000_000);
});

test('a time-based NIP-52 event uses unix seconds and is not all-day', () => {
  const resolved = resolveEvent(event({
    kind: KIND_CALENDAR_TIME,
    tags: [
      ['d', 'call-1'],
      ['title', 'Community call'],
      ['start', '1767225600'],
      ['end', '1767229200'],
      ['summary', 'Live call'],
    ],
  }));
  assert.ok(resolved);
  assert.equal(resolved.allDay, 0);
  assert.equal(resolved.startsAt, 1767225600);
  assert.equal(resolved.endsAt, 1767229200);
  assert.equal(resolved.location, null);
  assert.equal(resolved.endpoint, null);
});

test('deprecated name is accepted when title is absent', () => {
  const resolved = resolveEvent(event({ tags: [['d', 'old'], ['name', 'Legacy title'], ['start', '2026-01-01']] }));
  assert.equal(resolved.title, 'Legacy title');
});

test('an event with no d tag or no title is skipped', () => {
  assert.equal(resolveEvent(event({ tags: [['title', 'No identity'], ['start', '2026-01-01']] })), null);
  assert.equal(resolveEvent(event({ tags: [['d', 'x'], ['start', '2026-01-01']] })), null);
});

test('a malformed date is null rather than a bogus 1970 timestamp', () => {
  const resolved = resolveEvent(event({ tags: [['d', 'x'], ['title', 'Bad date'], ['start', 'December 1']] }));
  assert.equal(resolved.startsAt, null);
});

test('the first http(s) r link becomes the result endpoint; a non-URL r is ignored', () => {
  const resolved = resolveEvent(event({
    tags: [
      ['d', 'x'],
      ['title', 'Links'],
      ['start', '2026-01-01'],
      ['r', 'not a url'],
      ['r', 'wss://relay.example'],
      ['r', 'https://example.com/details'],
    ],
  }));
  assert.equal(resolved.endpoint, 'https://example.com/details');
});
