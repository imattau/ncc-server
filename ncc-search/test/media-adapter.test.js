import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseImetaTag,
  resolveMedia,
  KIND_PICTURE,
  KIND_VIDEO_NORMAL,
  KIND_VIDEO_NORMAL_ADDRESSABLE,
} from '../src/adapters/media.js';

test('parseImetaTag parses space-separated key-value fields', () => {
  const tag = ['imeta', 'url https://example.com/a.jpg', 'm image/jpeg', 'dim 100x200', 'alt A photo'];
  assert.deepEqual(parseImetaTag(tag), {
    url: 'https://example.com/a.jpg',
    m: 'image/jpeg',
    dim: '100x200',
    alt: 'A photo',
  });
});

test('parseImetaTag collects repeated keys (fallback) into an array', () => {
  const tag = ['imeta', 'url https://a.example/x.jpg', 'fallback https://b.example/x.jpg', 'fallback https://c.example/x.jpg'];
  const parsed = parseImetaTag(tag);
  assert.deepEqual(parsed.fallback, ['https://b.example/x.jpg', 'https://c.example/x.jpg']);
});

test('resolveMedia (picture, kind 20) keys by the event id, not a d tag', () => {
  const event = {
    id: 'event-id-1',
    pubkey: 'b'.repeat(64),
    kind: KIND_PICTURE,
    created_at: 1_700_000_000,
    content: 'A sunset',
    tags: [
      ['title', 'Sunset'],
      ['imeta', 'url https://cdn.example.com/sunset.jpg', 'm image/jpeg', 'alt Sunset over water'],
      ['t', 'photography'],
    ],
  };

  const resolved = resolveMedia(event);
  assert.equal(resolved.itemId, 'event-id-1');
  assert.equal(resolved.kind, 'image');
  assert.equal(resolved.mediaUrl, 'https://cdn.example.com/sunset.jpg');
  assert.equal(resolved.mediaType, 'image/jpeg');
  assert.equal(resolved.thumbnailUrl, 'https://cdn.example.com/sunset.jpg', 'an image is its own thumbnail');
  assert.match(resolved.body, /Sunset over water/);
  assert.equal(resolved.postedAt, 1_700_000_000, 'a media row is dated by its event');
  assert.deepEqual(resolved.hashtags, ['photography']);
});

test('resolveMedia (video, kind 21) uses the imeta `image` field as the thumbnail, not the video url', () => {
  const event = {
    id: 'event-id-2',
    pubkey: 'c'.repeat(64),
    kind: KIND_VIDEO_NORMAL,
    content: 'My trip',
    tags: [
      ['title', 'My Trip'],
      ['imeta', 'url https://cdn.example.com/trip.mp4', 'm video/mp4', 'image https://cdn.example.com/trip-poster.jpg', 'duration 42.5'],
    ],
  };

  const resolved = resolveMedia(event);
  assert.equal(resolved.itemId, 'event-id-2');
  assert.equal(resolved.kind, 'video');
  assert.equal(resolved.mediaUrl, 'https://cdn.example.com/trip.mp4');
  assert.equal(resolved.thumbnailUrl, 'https://cdn.example.com/trip-poster.jpg');
  assert.equal(resolved.duration, 42.5);
});

test('resolveMedia collapses a repeated imeta key to its first value, not an array', () => {
  // Found live, crawling real relays: a published video repeated `image`
  // within one `imeta` tag. parseImetaTag's repeated-key handling (meant
  // for `fallback`) applies to any key, so `primary.image` came back as
  // `['...jpg', '...png']` -- an array landing straight in a TEXT column
  // crashed the whole insert with "SQLite3 can only bind numbers, strings,
  // bigints, buffers, and null" (see store.js's upsertRow). Every
  // single-value field resolveMedia reads must survive this the same way.
  const event = {
    id: 'event-repeated-key',
    pubkey: 'd'.repeat(64),
    kind: KIND_VIDEO_NORMAL,
    content: 'Two posters, one video',
    tags: [
      ['title', 'Repeated Key'],
      [
        'imeta',
        'url https://cdn.example.com/clip.mp4',
        'm video/mp4',
        'image https://cdn.example.com/poster-1.jpg',
        'image https://cdn.example.com/poster-2.jpg',
      ],
    ],
  };

  const resolved = resolveMedia(event);
  assert.equal(typeof resolved.thumbnailUrl, 'string');
  assert.equal(resolved.thumbnailUrl, 'https://cdn.example.com/poster-1.jpg');
});

test('resolveMedia captures blurhash and thumbhash from the imeta tag when present', () => {
  const event = {
    id: 'e-hash',
    pubkey: 'f'.repeat(64),
    kind: KIND_PICTURE,
    content: 'A sunset',
    tags: [
      ['title', 'Sunset'],
      ['imeta', 'url https://cdn.example.com/sunset.jpg', 'blurhash LEHV6nWB2yk8pyo0adR*.7kCMdnj', 'thumbhash 1QcSHQRnh493V4dIh4eXh1h4kIeH'],
    ],
  };
  const resolved = resolveMedia(event);
  assert.equal(resolved.blurhash, 'LEHV6nWB2yk8pyo0adR*.7kCMdnj');
  assert.equal(resolved.thumbhash, '1QcSHQRnh493V4dIh4eXh1h4kIeH');
});

test('resolveMedia leaves blurhash/thumbhash null when absent, rather than guessing', () => {
  const event = {
    id: 'e-no-hash',
    pubkey: 'f'.repeat(64),
    kind: KIND_PICTURE,
    content: '',
    tags: [['title', 'No placeholder'], ['imeta', 'url https://cdn.example.com/x.jpg']],
  };
  const resolved = resolveMedia(event);
  assert.equal(resolved.blurhash, null);
  assert.equal(resolved.thumbhash, null);
});

test('resolveMedia captures the content-warning tag\'s reason text', () => {
  const event = {
    id: 'e-cw-1',
    pubkey: 'g'.repeat(64),
    kind: KIND_PICTURE,
    content: '',
    tags: [['title', 'Flagged'], ['imeta', 'url https://cdn.example.com/x.jpg'], ['content-warning', 'nsfw']],
  };
  assert.equal(resolveMedia(event).contentWarning, 'nsfw');
});

test('resolveMedia falls back to a generic label when content-warning has no reason', () => {
  const event = {
    id: 'e-cw-2',
    pubkey: 'g'.repeat(64),
    kind: KIND_PICTURE,
    content: '',
    tags: [['title', 'Flagged, no reason'], ['imeta', 'url https://cdn.example.com/y.jpg'], ['content-warning']],
  };
  assert.equal(resolveMedia(event).contentWarning, 'sensitive content');
});

test('resolveMedia leaves contentWarning null when the tag is absent', () => {
  const event = {
    id: 'e-cw-3',
    pubkey: 'g'.repeat(64),
    kind: KIND_PICTURE,
    content: '',
    tags: [['title', 'Clean'], ['imeta', 'url https://cdn.example.com/z.jpg']],
  };
  assert.equal(resolveMedia(event).contentWarning, null);
});

test('resolveMedia returns null when there is no usable imeta url', () => {
  const event = { id: 'e3', pubkey: 'd'.repeat(64), kind: KIND_PICTURE, content: '', tags: [['title', 'Nothing']] };
  assert.equal(resolveMedia(event), null);
});

test('resolveMedia (addressable video, kind 34235) keys by the d tag instead of the event id', () => {
  const event = {
    id: 'event-id-4',
    pubkey: 'e'.repeat(64),
    kind: KIND_VIDEO_NORMAL_ADDRESSABLE,
    content: '',
    tags: [
      ['d', 'my-addressable-video'],
      ['title', 'Addressable video'],
      ['imeta', 'url https://cdn.example.com/v.mp4', 'm video/mp4'],
    ],
  };

  const resolved = resolveMedia(event);
  assert.equal(resolved.itemId, 'my-addressable-video');
});
