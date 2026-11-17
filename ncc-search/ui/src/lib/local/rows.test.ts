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
