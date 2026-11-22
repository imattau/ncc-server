import { test } from 'vitest';
import assert from 'node:assert/strict';

import type { NostrEvent } from '@nostrify/nostrify';

import {
  eventToRow,
  makeSnippet,
  rowKey,
  shouldReplace,
  toSearchResult,
} from './rows';

const NOW = 1_800_000_000;

function event(overrides: Partial<NostrEvent> & { kind: number }): NostrEvent {
  return {
    id: 'e'.repeat(64),
    pubkey: 'a'.repeat(64),
    created_at: 1_700_000_000,
    content: '',
    tags: [],
    sig: 'f'.repeat(128),
    ...overrides,
  } as NostrEvent;
}

test('an article takes its posting date from published_at and strips Markdown for search', () => {
  const row = eventToRow(
    event({
      kind: 30023,
      created_at: 1_690_000_000,
      tags: [
        ['d', 'recap'],
        ['title', 'Weekly Recap'],
        ['summary', 'What happened'],
        ['published_at', '1700000000'],
        ['t', 'Nostr'],
        ['image', 'https://example.com/cover.jpg'],
      ],
      content: '# Heading\n\nA **bold** claim with [a link](https://example.com).',
    }),
    NOW,
  );

  assert.ok(row);
  assert.equal(row.itemId, 'recap');
  assert.equal(row.title, 'Weekly Recap');
  assert.equal(row.description, 'What happened');
  assert.equal(row.postedAt, 1_700_000_000);
  assert.equal(row.body, 'Heading A bold claim with a link.');
  assert.deepEqual(row.hashtags, ['nostr']);
  assert.equal(row.thumbnailUrl, 'https://example.com/cover.jpg');
});

test('an article without a d tag is not addressable and is skipped', () => {
  assert.equal(eventToRow(event({ kind: 30023, tags: [['title', 'No d']] }), NOW), null);
});

test('a picture row keeps the imeta media, alt text, blurhash and content warning', () => {
  const row = eventToRow(
    event({
      kind: 20,
      content: 'Sunset over water',
      tags: [
        ['imeta', 'url https://cdn.example.com/sunset.jpg', 'm image/jpeg', 'blurhash LEHV6nWB2yk8', 'alt A sunset'],
        ['t', 'Photography'],
        ['content-warning', 'flashing lights'],
      ],
    }),
    NOW,
  );

  assert.ok(row);
  assert.equal(row.kind, 'image');
  assert.equal(row.mediaUrl, 'https://cdn.example.com/sunset.jpg');
  assert.equal(row.mediaType, 'image/jpeg');
  assert.equal(row.thumbnailUrl, 'https://cdn.example.com/sunset.jpg');
  assert.equal(row.blurhash, 'LEHV6nWB2yk8');
  assert.equal(row.contentWarning, 'flashing lights');
  assert.deepEqual(row.hashtags, ['photography']);
  assert.match(row.body ?? '', /Sunset over water/);
});

test('a video uses the imeta image field as a poster, not the video file', () => {
  const row = eventToRow(
    event({
      kind: 34235,
      tags: [
        ['d', 'clip'],
        ['imeta', 'url https://cdn.example.com/clip.mp4', 'm video/mp4', 'image https://cdn.example.com/poster.jpg'],
      ],
    }),
    NOW,
  );

  assert.ok(row);
  assert.equal(row.itemId, 'clip');
  assert.equal(row.kind, 'video');
  assert.equal(row.mediaUrl, 'https://cdn.example.com/clip.mp4');
  assert.equal(row.thumbnailUrl, 'https://cdn.example.com/poster.jpg');
  assert.equal(row.mediaType, 'video/mp4');
});

test('a media event with no imeta url is skipped rather than rendered empty', () => {
  assert.equal(eventToRow(event({ kind: 20, tags: [['imeta', 'm image/jpeg']] }), NOW), null);
});

test('nsite manifests index by site id and resolve the published entry page', () => {
  const root = eventToRow(
    event({
      kind: 15128,
      tags: [
        ['path', '/index.html', 'a'.repeat(64)],
        ['path', '/assets/app.js', 'b'.repeat(64)],
        ['title', 'My site'],
        ['description', 'A site about things'],
      ],
    }),
    NOW,
  );
  assert.ok(root);
  assert.equal(root.itemId, '_root');
  assert.equal(root.kind, 'nsite-root');
  assert.equal(root.endpoint, '/index.html');
  assert.equal(root.title, 'My site');
  assert.equal(root.description, 'A site about things');

  const named = eventToRow(
    event({
      kind: 35128,
      tags: [['d', 'blog'], ['path', '/about.html', 'c'.repeat(64)]],
    }),
    NOW,
  );
  assert.ok(named);
  assert.equal(named.itemId, 'blog');
  assert.equal(named.kind, 'nsite-named');
  assert.equal(named.endpoint, '/about.html');
  // Many manifests have no title; the site id is then the only name a reader
  // could search for.
  assert.match(named.body ?? '', /blog/);
});

test('a named nsite needs its d tag; a root manifest without an entry page is still indexed', () => {
  assert.equal(eventToRow(event({ kind: 35128, tags: [['title', 'No d']] }), NOW), null);
  // A root manifest with no paths has nothing a reader could open.
  const noPaths = eventToRow(event({ kind: 15128, tags: [['title', 'Broken']] }), NOW);
  assert.ok(noPaths);
  assert.equal(noPaths.endpoint, null);
});

test('npack releases and NCC service records are searchable without fetching anything', () => {
  const release = eventToRow(
    event({
      kind: 9900,
      tags: [
        ['d', 'ncc-browser/1.2.0/x86_64'],
        ['name', 'ncc-browser'],
        ['version', '1.2.0'],
        ['os', 'linux'],
        ['arch', 'x86_64'],
        ['summary', 'A browser'],
        ['homepage', 'https://example.com'],
        ['category', 'Browser'],
      ],
    }),
    NOW,
  );
  assert.ok(release);
  assert.equal(release.title, 'ncc-browser 1.2.0 (linux/x86_64)');
  assert.equal(release.endpoint, 'https://example.com');
  assert.deepEqual(release.hashtags, ['browser']);
  // The artifact (download link) is a separate event the local index does not join.
  assert.equal(release.mediaUrl, null);

  const service = eventToRow(
    event({
      kind: 30059,
      tags: [['d', 'search'], ['u', 'https://search.example.com/']],
    }),
    NOW,
  );
  assert.ok(service);
  assert.equal(service.kind, 'ncc-service');
  assert.equal(service.title, 'search');
  assert.equal(service.endpoint, 'https://search.example.com/');
  assert.match(service.body ?? '', /search\.example\.com/);
});

test('a profile is searchable by claimed nip05 but does not display it as verified', () => {
  const row = eventToRow(
    event({
      kind: 0,
      content: JSON.stringify({
        name: 'alice',
        display_name: 'Alice',
        about: 'Alice does things',
        nip05: 'alice@example.com',
        picture: 'https://example.com/alice.jpg',
      }),
    }),
    NOW,
  );
  assert.ok(row);
  assert.equal(row.itemId, '_profile');
  assert.equal(row.kind, 'profile');
  assert.equal(row.title, 'Alice');
  assert.equal(row.description, 'Alice does things');
  assert.match(row.body ?? '', /alice@example\.com/);

  const result = toSearchResult(row, 'alice');
  assert.equal(result.nip05, null, 'a local index cannot verify a NIP-05 claim');
});

test('a newer event replaces an older one, an identical copy does not', () => {
  const older = eventToRow(event({ kind: 30023, created_at: 1_600_000_000, tags: [['d', 'post']] }), NOW);
  const newer = eventToRow(event({ kind: 30023, created_at: 1_700_000_000, tags: [['d', 'post']] }), NOW);
  const same = eventToRow(event({ kind: 30023, created_at: 1_700_000_000, tags: [['d', 'post']] }), NOW);

  assert.ok(older && newer && same);
  assert.equal(shouldReplace(undefined, older), true);
  assert.equal(shouldReplace(older, newer), true);
  assert.equal(shouldReplace(newer, same), false, 'the same event from another relay is not an update');
  assert.equal(newer.key, older.key);
  assert.equal(rowKey('article', 'a'.repeat(64), 'post'), newer.key);
});

test('snippets mark query terms with the backend delimiter and never emit brackets from the source', () => {
  const snippet = makeSnippet('Some text [bracketed] before the wallet feature arrives', 'wall');
  assert.match(snippet, /\[wallet\]/);
  assert.doesNotMatch(snippet, /\[bracketed\]/);

  assert.equal(makeSnippet('nothing relevant here', 'wallet'), '');
  assert.equal(makeSnippet(null, 'wallet'), '');
});

test('a short video (kind 22) becomes a short-video row, not a video row', () => {
  const row = eventToRow(
    event({
      kind: 22,
      tags: [
        ['title', 'A clip'],
        ['imeta', 'url https://cdn.example.com/clip.mp4', 'm video/mp4'],
      ],
    }),
    NOW,
  );
  assert.ok(row);
  assert.equal(row.kind, 'short-video');
});

test('a NIP-52 date-based event keeps its UTC date, location and all-day flag', () => {
  const row = eventToRow(
    event({
      kind: 31922,
      tags: [
        ['d', 'meetup'],
        ['title', 'Nostr Meetup'],
        ['summary', 'Monthly gathering'],
        ['start', '2026-12-01'],
        ['end', '2026-12-02'],
        ['location', 'Berlin'],
        ['location', 'Online'],
        ['image', 'https://example.com/meetup.jpg'],
        ['r', 'https://example.com/rsvp'],
      ],
      content: 'A **community** meetup',
    }),
    NOW,
  );

  assert.ok(row);
  assert.equal(row.kind, 'event');
  assert.equal(row.itemId, 'meetup');
  assert.equal(row.allDay, 1);
  assert.equal(row.startsAt, Date.UTC(2026, 11, 1) / 1000);
  assert.equal(row.endsAt, Date.UTC(2026, 11, 2) / 1000);
  assert.equal(row.location, 'Berlin · Online');
  assert.equal(row.endpoint, 'https://example.com/rsvp');
  assert.equal(row.thumbnailUrl, 'https://example.com/meetup.jpg');
  assert.match(row.body ?? '', /community meetup/);
});

test('a NIP-53 live stream row keeps status, times and the streaming link', () => {
  const row = eventToRow(
    event({
      kind: 30311,
      tags: [
        ['d', 'stream'],
        ['title', 'Friday stream'],
        ['summary', 'Talking about Nostr'],
        ['streaming', 'https://example.com/live.m3u8'],
        ['starts', '1800000000'],
        ['status', 'live'],
        ['current_participants', '42'],
      ],
    }),
    NOW,
  );

  assert.ok(row);
  assert.equal(row.kind, 'live-stream');
  assert.equal(row.liveStatus, 'live');
  assert.equal(row.startsAt, 1_800_000_000);
  assert.equal(row.participantCount, 42);
  assert.equal(row.endpoint, 'https://example.com/live.m3u8');

  const result = toSearchResult(row, 'stream');
  assert.equal(result.liveStatus, 'live');
  assert.equal(result.startsAt, 1_800_000_000_000);
  assert.equal(result.participantCount, 42);
});

test('a Zapstore app event becomes an app row with a store link and platforms', () => {
  const row = eventToRow(
    event({
      kind: 32267,
      content: 'A **private** app store.',
      tags: [
        ['d', 'dev.zapstore.app'],
        ['name', 'Zapstore'],
        ['summary', 'The private app store'],
        ['icon', 'https://cdn.example.com/icon.png'],
        ['f', 'android-arm64-v8a'],
        ['f', 'linux-x86_64'],
        ['t', 'Android'],
      ],
    }),
    NOW,
  );

  assert.ok(row);
  assert.equal(row.kind, 'app');
  assert.equal(row.itemId, 'dev.zapstore.app');
  assert.equal(row.title, 'Zapstore');
  assert.equal(row.description, 'The private app store');
  assert.equal(row.thumbnailUrl, 'https://cdn.example.com/icon.png');
  assert.equal(row.endpoint, 'https://zapstore.dev/apps/dev.zapstore.app');
  assert.deepEqual(row.platforms, ['android-arm64-v8a', 'linux-x86_64']);
  assert.deepEqual(row.hashtags, ['android']);
  assert.equal(row.body, 'A private app store.');

  const result = toSearchResult(row, 'zapstore');
  assert.equal(result.kind, 'app');
  assert.equal(result.platforms?.[0], 'android-arm64-v8a');
});

test('an app with no name is not indexed', () => {
  assert.equal(eventToRow(event({ kind: 32267, tags: [['d', 'example.app']] }), NOW), null);
});

test('a NIP-72 community row keeps its image and has no external link', () => {
  const row = eventToRow(
    event({
      kind: 34550,
      content: 'A place for writers.',
      tags: [
        ['d', 'writers'],
        ['name', 'Nostr Writers'],
        ['description', 'Fiction and non-fiction'],
        ['image', 'https://cdn.example.com/community.png'],
      ],
    }),
    NOW,
  );

  assert.ok(row);
  assert.equal(row.kind, 'community');
  assert.equal(row.title, 'Nostr Writers');
  assert.equal(row.description, 'Fiction and non-fiction');
  assert.equal(row.thumbnailUrl, 'https://cdn.example.com/community.png');
  assert.equal(row.endpoint, null);
  assert.match(row.body ?? '', /A place for writers\./);
});

test('the d tag is the community title when no name is set', () => {
  const row = eventToRow(event({ kind: 34550, tags: [['d', 'writers']] }), NOW);
  assert.equal(row?.title, 'writers');
});
