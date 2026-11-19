import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, KIND_ARTICLE, KIND_IMAGE, KIND_NSITE_NAMED, KIND_PROFILE } from '../src/store.js';

function freshStore() {
  const dir = mkdtempSync(join(tmpdir(), 'ncc-search-store-content-test-'));
  const store = openStore(join(dir, 'test.db'));
  return { store, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('upsertContent indexes an article with no reachability claim', () => {
  const { store, cleanup } = freshStore();
  try {
    store.upsertContent({
      pubkey: 'a'.repeat(64),
      itemId: 'my-post',
      kind: KIND_ARTICLE,
      title: 'My Post',
      description: 'A summary',
      body: 'The full article body mentions wallets.',
      mediaUrl: null,
      mediaType: null,
      thumbnailUrl: 'https://example.com/cover.jpg',
      endpoint: null,
    });

    const row = store.getService('a'.repeat(64), 'my-post');
    assert.equal(row.kind, KIND_ARTICLE);
    assert.equal(row.last_status, null, 'articles are never fetched, so there is no status to report');
    assert.equal(row.last_reachable_at, null);
    assert.equal(row.thumbnail_url, 'https://example.com/cover.jpg');

    const results = store.search('wallets');
    assert.equal(results.length, 1);
    assert.equal(results[0].itemId, 'my-post');
  } finally {
    cleanup();
  }
});

test('upsertContent stores the posting date and a later date-less update does not erase it', () => {
  const { store, cleanup } = freshStore();
  try {
    store.upsertContent({
      pubkey: 'a'.repeat(64),
      itemId: 'dated-post',
      kind: KIND_ARTICLE,
      title: 'Dated post',
      description: null,
      body: 'Some searchable text.',
      postedAt: 1_700_000_000,
    });

    assert.equal(store.getService('a'.repeat(64), 'dated-post').posted_at, 1_700_000_000);
    assert.equal(store.search('searchable')[0].postedAt, 1_700_000_000_000, 'postedAt is Unix milliseconds');

    // e.g. the npack artifact arriving later, or a NIP-05 recheck: neither
    // has an event to read a date from, and neither may blank the stored one.
    store.upsertContent({
      pubkey: 'a'.repeat(64),
      itemId: 'dated-post',
      kind: KIND_ARTICLE,
      title: 'Dated post',
      description: null,
      body: 'Some searchable text.',
    });

    assert.equal(store.getService('a'.repeat(64), 'dated-post').posted_at, 1_700_000_000);
  } finally {
    cleanup();
  }
});

test('FTS ranks title matches above a repeated match in the body and exposes index time', () => {
  const { store, cleanup } = freshStore();
  try {
    store.upsertContent({
      pubkey: '1'.repeat(64), itemId: 'title-match', kind: KIND_ARTICLE,
      title: 'Solar guide', description: null, body: 'A short guide.',
    });
    store.upsertContent({
      pubkey: '2'.repeat(64), itemId: 'body-match', kind: KIND_ARTICLE,
      title: 'General notes', description: null, body: 'solar '.repeat(80),
    });

    const results = store.search('solar');
    assert.equal(results[0].itemId, 'title-match');
    assert.ok(results[0].indexedAt > 1_000_000_000_000, 'indexedAt is Unix milliseconds');
  } finally {
    cleanup();
  }
});

test('curated relevance cases return the expected title match first', () => {
  const { store, cleanup } = freshStore();
  try {
    const cases = [
      { query: 'wallet security', expected: 'wallet-security', title: 'Wallet security basics', body: 'Key management guide.' },
      { query: 'solar mapping', expected: 'solar-mapping', title: 'Solar mapping project', body: 'Satellite imagery notes.' },
      { query: 'leather bags', expected: 'leather-bags', title: 'Leather bags and care', body: 'Materials and maintenance.' },
    ];
    for (const [index, item] of cases.entries()) {
      store.upsertContent({
        pubkey: String(index + 3).repeat(64), itemId: item.expected, kind: KIND_ARTICLE,
        title: item.title, description: null, body: item.body,
      });
    }

    for (const item of cases) {
      assert.equal(store.search(item.query)[0]?.itemId, item.expected, `top result for ${item.query}`);
    }
  } finally {
    cleanup();
  }
});

test('discovery cursors persist independently for each source and relay', () => {
  const { store, cleanup } = freshStore();
  try {
    store.saveDiscoveryCursor('articles', 'wss://relay.example', 1234);
    store.saveDiscoveryCursor('media', 'wss://relay.example', 5678);
    store.saveDiscoveryCursor('articles', 'wss://relay.example', 1000);

    assert.equal(store.getDiscoveryCursor('articles', 'wss://relay.example'), 1234);
    assert.equal(store.getDiscoveryCursor('media', 'wss://relay.example'), 5678);
  } finally {
    cleanup();
  }
});

test('upsertNsite indexes the fetched page body, not just title/description', () => {
  const { store, cleanup } = freshStore();
  try {
    const resolved = {
      pubkey: 'f'.repeat(64),
      kind: 35128,
      siteId: 'blog',
      title: 'My nsite',
      description: null,
    };

    // NsiteAdapter.fetchAndExtract() returns extractDocument()'s own field
    // name, `text` -- see test/nsite-adapter.test.js -- not `body`. The
    // regression this guards: that page content must still end up
    // searchable, not just the title/description.
    store.upsertNsite(resolved, {
      status: 200,
      title: 'My nsite',
      text: 'This page is about leather wallets and bags.',
    });

    const row = store.getService(resolved.pubkey, 'blog');
    assert.equal(row.body, 'This page is about leather wallets and bags.');

    const results = store.search('wallets');
    assert.equal(results.length, 1);
    assert.equal(results[0].itemId, 'blog');
  } finally {
    cleanup();
  }
});

test('upsertNsite records which relays delivered the event, and a later pass with none keeps it', () => {
  const { store, cleanup } = freshStore();
  try {
    const resolved = {
      pubkey: 'd'.repeat(64),
      kind: 35128,
      siteId: 'blog',
      title: 'My nsite',
      description: null,
    };

    store.upsertNsite(
      resolved,
      { status: 200, title: 'My nsite' },
      null,
      ['wss://relay.b.example', 'wss://relay.a.example'],
    );

    const row = store.getService(resolved.pubkey, 'blog');
    assert.deepEqual(JSON.parse(row.seen_relays), ['wss://relay.b.example', 'wss://relay.a.example']);

    // A later pass that didn't record any relays (e.g. the NIP-05-only
    // enrichment path) must not blank this out -- same COALESCE guarantee
    // title/description/thumbnail already rely on.
    store.upsertNsite(resolved, { status: 200, title: 'My nsite' }, null, []);
    const after = store.getService(resolved.pubkey, 'blog');
    assert.deepEqual(JSON.parse(after.seen_relays), ['wss://relay.b.example', 'wss://relay.a.example']);
  } finally {
    cleanup();
  }
});

test('upsertNsite stores an extracted og:image as the thumbnail, and a later fetch with none keeps it', () => {
  const { store, cleanup } = freshStore();
  try {
    const resolved = {
      pubkey: 'c'.repeat(64),
      kind: 35128,
      siteId: 'blog',
      title: 'My nsite',
      description: null,
    };

    store.upsertNsite(resolved, { status: 200, title: 'My nsite', image: 'https://cdn.example/cover.png' });

    const row = store.getService(resolved.pubkey, 'blog');
    assert.equal(row.kind, KIND_NSITE_NAMED);
    assert.equal(row.thumbnail_url, 'https://cdn.example/cover.png');

    // A re-crawl that found no og:image (e.g. the NIP-05-only enrichment
    // pass, which fetches no content at all) must not blank out a
    // thumbnail a previous fetch already found -- same COALESCE guarantee
    // title/description/body already rely on, see store.js's upsertRow.
    store.upsertNsite(resolved, { status: 200, title: 'My nsite' });
    const after = store.getService(resolved.pubkey, 'blog');
    assert.equal(after.thumbnail_url, 'https://cdn.example/cover.png');
  } finally {
    cleanup();
  }
});

test('attachNip05 updates every row for a pubkey across kinds, and keeps body text intact', () => {
  const { store, cleanup } = freshStore();
  try {
    const pubkey = 'b'.repeat(64);
    store.upsertContent({
      pubkey,
      itemId: 'article-1',
      kind: KIND_ARTICLE,
      title: 'Article',
      description: null,
      body: 'searchable article body',
      mediaUrl: null,
      mediaType: null,
      thumbnailUrl: null,
      endpoint: null,
    });
    store.upsertContent({
      pubkey,
      itemId: 'image-1',
      kind: KIND_IMAGE,
      title: 'A picture',
      description: null,
      body: 'searchable image caption',
      mediaUrl: 'https://cdn.example.com/x.jpg',
      mediaType: 'image/jpeg',
      thumbnailUrl: 'https://cdn.example.com/x.jpg',
      endpoint: null,
    });

    store.attachNip05(pubkey, 'alice@example.com');

    const article = store.getService(pubkey, 'article-1');
    const image = store.getService(pubkey, 'image-1');
    assert.equal(article.nip05, 'alice@example.com');
    assert.equal(image.nip05, 'alice@example.com');
    // The regression this guards: attaching nip05 must not blank out
    // previously-indexed body text (see store.js's syncFts/upsertRow).
    assert.equal(article.body, 'searchable article body');
    assert.equal(image.body, 'searchable image caption');

    const results = store.search('caption');
    assert.equal(results.length, 1);
    assert.equal(results[0].nip05, 'alice@example.com');
  } finally {
    cleanup();
  }
});

test('backfill helpers page undated content rows and never overwrite a stored date', () => {
  const { store, cleanup } = freshStore();
  try {
    store.upsertContent({
      pubkey: 'a'.repeat(64), itemId: 'early', kind: KIND_ARTICLE,
      title: 'Early', description: null, body: 'text',
    });
    store.upsertContent({
      pubkey: 'b'.repeat(64), itemId: 'late', kind: KIND_ARTICLE,
      title: 'Late', description: null, body: 'text',
    });
    store.upsertContent({
      pubkey: 'c'.repeat(64), itemId: 'dated', kind: KIND_ARTICLE,
      title: 'Dated', description: null, body: 'text', postedAt: 1_700_000_000,
    });
    // Profiles are not backfillable -- there is no posting date to find.
    store.upsertContent({
      pubkey: 'd'.repeat(64), itemId: '_profile', kind: KIND_PROFILE,
      title: 'Someone', description: null, body: null,
    });

    assert.equal(store.countMissingPostedAt(), 2);

    const first = store.listMissingPostedAt(null, 1);
    assert.deepEqual(first.map((row) => row.itemId), ['early']);

    const cursor = { pubkey: first[0].pubkey, itemId: first[0].itemId };
    assert.deepEqual(store.listMissingPostedAt(cursor, 10).map((row) => row.itemId), ['late']);

    assert.equal(store.setPostedAt('a'.repeat(64), 'early', 1_500_000_000), 1);
    assert.equal(store.setPostedAt('a'.repeat(64), 'early', 1_400_000_000), 0, 'an already-dated row is left alone');
    assert.equal(store.getService('a'.repeat(64), 'early').posted_at, 1_500_000_000);
    assert.equal(store.countMissingPostedAt(), 1);

    // The backfill writes one author's dates as a single transaction; it must
    // apply the same guard per row, and an already-dated row inside a batch
    // must not be overwritten.
    const changed = store.setPostedAtBatch([
      { pubkey: 'b'.repeat(64), itemId: 'late', postedAt: 1_600_000_000 },
      { pubkey: 'a'.repeat(64), itemId: 'early', postedAt: 1_300_000_000 },
      { pubkey: 'c'.repeat(64), itemId: 'dated', postedAt: 1_200_000_000 },
    ]);
    assert.equal(changed, 1, 'only the still-undated row changes');
    assert.equal(store.getService('b'.repeat(64), 'late').posted_at, 1_600_000_000);
    assert.equal(store.getService('a'.repeat(64), 'early').posted_at, 1_500_000_000);
    assert.equal(store.getService('c'.repeat(64), 'dated').posted_at, 1_700_000_000);
    assert.equal(store.setPostedAtBatch([]), 0, 'an empty batch is a no-op, not a transaction');
    assert.equal(store.countMissingPostedAt(), 0);
  } finally {
    cleanup();
  }
});

test('upsertContent stores event times, all-day flag and location', () => {
  const { store, cleanup } = freshStore();
  try {
    store.upsertContent({
      pubkey: 'a'.repeat(64),
      itemId: 'meetup',
      kind: 'event',
      title: 'Nostr Meetup',
      description: 'Monthly gathering',
      body: 'Monthly gathering Berlin',
      endpoint: 'https://example.com/rsvp',
      thumbnailUrl: 'https://example.com/meetup.jpg',
      allDay: 1,
      startsAt: 1_800_000_000,
      endsAt: 1_800_086_400,
      location: 'Berlin',
      status: null,
      participantCount: null,
      postedAt: 1_700_000_000,
      hashtags: ['nostr'],
    });

    const row = store.getService('a'.repeat(64), 'meetup');
    assert.equal(row.kind, 'event');
    assert.equal(row.starts_at, 1_800_000_000);
    assert.equal(row.ends_at, 1_800_086_400);
    assert.equal(row.all_day, 1);
    assert.equal(row.location, 'Berlin');

    const result = store.search('Berlin')[0];
    assert.equal(result.startsAt, 1_800_000_000_000);
    assert.equal(result.endsAt, 1_800_086_400_000);
    assert.equal(result.allDay, 1);
    assert.equal(result.location, 'Berlin');
  } finally {
    cleanup();
  }
});

test('upsertContent stores a live stream status and participant count', () => {
  const { store, cleanup } = freshStore();
  try {
    store.upsertContent({
      pubkey: 'a'.repeat(64),
      itemId: 'stream',
      kind: 'live-stream',
      title: 'Friday stream',
      description: 'Talking about Nostr',
      body: 'Talking about Nostr',
      status: 'live',
      participantCount: 42,
      startsAt: 1_800_000_000,
      postedAt: 1_700_000_000,
    });

    const row = store.getService('a'.repeat(64), 'stream');
    assert.equal(row.status, 'live');
    assert.equal(row.participant_count, 42);

    const result = store.search('Friday')[0];
    assert.equal(result.liveStatus, 'live');
    assert.equal(result.participantCount, 42);
  } finally {
    cleanup();
  }
});

test('short videos are stored under their own kind', () => {
  const { store, cleanup } = freshStore();
  try {
    store.upsertContent({
      pubkey: 'a'.repeat(64),
      itemId: 'clip',
      kind: 'short-video',
      title: 'A clip',
      postedAt: 1_700_000_000,
    });

    assert.equal(store.getService('a'.repeat(64), 'clip').kind, 'short-video');
    assert.equal(store.search('clip')[0].kind, 'short-video');
  } finally {
    cleanup();
  }
});

test('the video reclassify helpers page video rows and only change rows still marked video', () => {
  const { store, cleanup } = freshStore();
  try {
    store.upsertContent({ pubkey: 'a'.repeat(64), itemId: 'v1', kind: 'video', title: 'Video 1' });
    store.upsertContent({ pubkey: 'a'.repeat(64), itemId: 'v2', kind: 'video', title: 'Video 2' });
    store.upsertContent({ pubkey: 'a'.repeat(64), itemId: 's1', kind: 'short-video', title: 'Short 1' });

    assert.equal(store.countVideoRowsForReclassify(), 2);
    const rows = store.listVideoRowsForReclassify(null, 10);
    assert.deepEqual(rows.map((row) => row.itemId), ['v1', 'v2']);

    assert.equal(store.setVideoKind('a'.repeat(64), 'v1', 'short-video'), 1);
    assert.equal(store.setVideoKind('a'.repeat(64), 'v1', 'short-video'), 0, 'already changed');
    assert.equal(store.getService('a'.repeat(64), 'v1').kind, 'short-video');
    assert.equal(store.countVideoRowsForReclassify(), 1);

    assert.equal(
      store.setVideoKindBatch([{ pubkey: 'a'.repeat(64), itemId: 'v2', kind: 'short-video' }]),
      1,
    );
    assert.equal(store.countVideoRowsForReclassify(), 0);
  } finally {
    cleanup();
  }
});
