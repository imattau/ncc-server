import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Nip50Adapter } from '../src/adapters/nip50.js';
import { SERVICE_RECORD_KIND } from '../src/discovery.js';
import { KIND_ROOT_SITE, KIND_NAMED_SITE } from '../src/adapters/nsite.js';
import { KIND_ARTICLE_EVENT } from '../src/adapters/article.js';
import { KIND_PICTURE, KIND_VIDEO_NORMAL, KIND_VIDEO_SHORT } from '../src/adapters/media.js';
import { KIND_CALENDAR_DATE } from '../src/adapters/calendar.js';
import { KIND_LIVE_STREAM } from '../src/adapters/live.js';

function fakeConfig(overrides = {}) {
  return { relays: ['wss://relay.example'], fetchTimeoutMs: 1000, ...overrides };
}

function fakePool(events) {
  return { querySync: async () => events };
}

function stubCrawler() {
  const ingested = [];
  return { ingested, ingestEvent: (event) => ingested.push(event) };
}

function nccEvent({ id = 'e1', pubkey = 'a'.repeat(64), dTag = 'web', title, description } = {}) {
  const tags = [['d', dTag]];
  if (title) tags.push(['title', title]);
  if (description) tags.push(['description', description]);
  return { id, kind: SERVICE_RECORD_KIND, pubkey, tags, content: '', created_at: 0 };
}

function nsiteEvent({ id = 'e2', pubkey = 'b'.repeat(64), kind = KIND_NAMED_SITE, dTag = 'blog' } = {}) {
  const tags = kind === KIND_NAMED_SITE ? [['d', dTag]] : [];
  return { id, kind, pubkey, tags, content: '', created_at: 0 };
}

function stubContentCrawler() {
  const ingestedArticles = [];
  const ingestedMedia = [];
  const ingestedEvents = [];
  const ingestedLive = [];
  return {
    ingestedArticles,
    ingestedMedia,
    ingestedEvents,
    ingestedLive,
    ingestArticle: (event) => ingestedArticles.push(event),
    ingestMedia: (event) => ingestedMedia.push(event),
    ingestEvent: (event) => ingestedEvents.push(event),
    ingestLiveStream: (event) => ingestedLive.push(event),
  };
}

function articleEvent({
  id = 'e4',
  pubkey = 'd'.repeat(64),
  dTag = 'my-post',
  title = 'My Post',
  summary,
  content = 'the body',
} = {}) {
  const tags = [['d', dTag], ['title', title]];
  if (summary) tags.push(['summary', summary]);
  return { id, kind: KIND_ARTICLE_EVENT, pubkey, tags, content, created_at: 0 };
}

function mediaEvent({ id = 'e5', pubkey = 'e'.repeat(64), kind = KIND_PICTURE, title = 'A photo' } = {}) {
  return {
    id,
    kind,
    pubkey,
    tags: [['title', title], ['imeta', 'url https://cdn.example.com/x.jpg', 'm image/jpeg']],
    content: 'a caption',
    created_at: 0,
  };
}

test('search() short-circuits to [] when no configured relay advertises NIP-50', async () => {
  const adapter = new Nip50Adapter(fakePool([nccEvent()]), fakeConfig());
  adapter.prober = { filterCapable: async () => [] }; // no relay supports NIP-50

  const hits = await adapter.search('wallet');
  assert.deepEqual(hits, []);
});

test('search() maps an NCC-02 service record to a live hit and ingests it into the NCC crawler', async () => {
  const event = nccEvent({ title: 'My Wallet', description: 'self-hosted wallet' });
  const nccCrawler = stubCrawler();
  const nsiteCrawler = stubCrawler();
  const adapter = new Nip50Adapter(fakePool([event]), fakeConfig(), { nccCrawler, nsiteCrawler });
  adapter.prober = { filterCapable: async (relays) => relays };

  const hits = await adapter.search('wallet');

  assert.equal(hits.length, 1);
  assert.deepEqual(hits[0], {
    pubkey: event.pubkey,
    kind: 'ncc-service',
    itemId: 'web',
    title: 'My Wallet',
    description: 'self-hosted wallet',
    eventId: 'e1',
    source: 'live',
  });
  assert.equal(nccCrawler.ingested.length, 1);
  assert.equal(nccCrawler.ingested[0], event);
  assert.equal(nsiteCrawler.ingested.length, 0, 'nsite crawler must not see an NCC event');
});

test('search() maps a root nsite to itemId "_root" and ingests it into the nsite crawler', async () => {
  const event = nsiteEvent({ kind: KIND_ROOT_SITE });
  const nccCrawler = stubCrawler();
  const nsiteCrawler = stubCrawler();
  const adapter = new Nip50Adapter(fakePool([event]), fakeConfig(), { nccCrawler, nsiteCrawler });
  adapter.prober = { filterCapable: async (relays) => relays };

  const hits = await adapter.search('blog');

  assert.equal(hits[0].kind, 'nsite-root');
  assert.equal(hits[0].itemId, '_root');
  assert.equal(nsiteCrawler.ingested.length, 1);
  assert.equal(nccCrawler.ingested.length, 0, 'ncc crawler must not see an nsite event');
});

test('search() maps a named nsite to its d-tag itemId', async () => {
  const event = nsiteEvent({ kind: KIND_NAMED_SITE, dTag: 'blog' });
  const adapter = new Nip50Adapter(fakePool([event]), fakeConfig());
  adapter.prober = { filterCapable: async (relays) => relays };

  const hits = await adapter.search('blog');
  assert.equal(hits[0].kind, 'nsite-named');
  assert.equal(hits[0].itemId, 'blog');
});

test('search() discards events of kinds outside the NCC/nsite set, even if a lenient relay returns them', async () => {
  const offKind = { id: 'e3', kind: 1, pubkey: 'c'.repeat(64), tags: [], content: 'just a note', created_at: 0 };
  const adapter = new Nip50Adapter(fakePool([offKind]), fakeConfig());
  adapter.prober = { filterCapable: async (relays) => relays };

  const hits = await adapter.search('anything');
  assert.deepEqual(hits, []);
});

test('search() routes a NIP-23 article to the content crawler and maps summary -> description', async () => {
  const event = articleEvent({ summary: 'A short summary' });
  const contentCrawler = stubContentCrawler();
  const adapter = new Nip50Adapter(fakePool([event]), fakeConfig(), { contentCrawler });
  adapter.prober = { filterCapable: async (relays) => relays };

  const hits = await adapter.search('post');

  assert.equal(hits.length, 1);
  assert.equal(hits[0].kind, 'article');
  assert.equal(hits[0].itemId, 'my-post');
  assert.equal(hits[0].description, 'A short summary');
  assert.equal(contentCrawler.ingestedArticles.length, 1);
  assert.equal(contentCrawler.ingestedMedia.length, 0);
});

test('search() strips Markdown from a live article hit with no summary/description tag', async () => {
  const event = articleEvent({
    content: '# Heading\n\nSome **bold** text with a [link](nostr:naddr1qpuksar5wabc) inside.',
  });
  const contentCrawler = stubContentCrawler();
  const adapter = new Nip50Adapter(fakePool([event]), fakeConfig(), { contentCrawler });
  adapter.prober = { filterCapable: async (relays) => relays };

  const hits = await adapter.search('post');

  assert.equal(hits.length, 1);
  // Same cleanup resolveArticle()/stripMarkdown.js already gives a
  // properly crawled article's body -- a live-only hit falling back to
  // raw NIP-23 `content` must not skip it and leak Markdown syntax (or an
  // un-stripped `nostr:` reference buried inside a link) into the result.
  assert.equal(hits[0].description, 'Heading Some bold text with a link inside.');
});

test('search() routes a NIP-68 picture to the content crawler, keyed by event id (not addressable)', async () => {
  const event = mediaEvent({ kind: KIND_PICTURE });
  const contentCrawler = stubContentCrawler();
  const adapter = new Nip50Adapter(fakePool([event]), fakeConfig(), { contentCrawler });
  adapter.prober = { filterCapable: async (relays) => relays };

  const hits = await adapter.search('photo');

  assert.equal(hits[0].kind, 'image');
  assert.equal(hits[0].itemId, 'e5');
  assert.equal(contentCrawler.ingestedMedia.length, 1);
  assert.equal(contentCrawler.ingestedArticles.length, 0);
});

test('search() routes a NIP-71 video (kind 21) to the content crawler as kind "video"', async () => {
  const event = mediaEvent({ kind: KIND_VIDEO_NORMAL, id: 'e6', title: 'My Trip' });
  const contentCrawler = stubContentCrawler();
  const adapter = new Nip50Adapter(fakePool([event]), fakeConfig(), { contentCrawler });
  adapter.prober = { filterCapable: async (relays) => relays };

  const hits = await adapter.search('trip');
  assert.equal(hits[0].kind, 'video');
  assert.equal(hits[0].itemId, 'e6');
});

test('search() resolves to [] rather than hanging if querySync never returns within the timeout', async () => {
  const neverResolves = { querySync: () => new Promise(() => {}) };
  const adapter = new Nip50Adapter(neverResolves, fakeConfig({ fetchTimeoutMs: 20 }));
  adapter.prober = { filterCapable: async (relays) => relays };

  const start = Date.now();
  const hits = await adapter.search('anything');
  const elapsed = Date.now() - start;

  assert.deepEqual(hits, []);
  assert.ok(elapsed < 1000, `expected the timeout race to resolve quickly, took ${elapsed}ms`);
});

test('search() maps an addressable short video (kind 22) to "short-video"', async () => {
  const event = mediaEvent({ kind: KIND_VIDEO_SHORT, id: 'e7', title: 'A short' });
  const contentCrawler = stubContentCrawler();
  const adapter = new Nip50Adapter(fakePool([event]), fakeConfig(), { contentCrawler });
  adapter.prober = { filterCapable: async (relays) => relays };

  const hits = await adapter.search('short');
  assert.equal(hits[0].kind, 'short-video');
  assert.equal(contentCrawler.ingestedMedia.length, 1);
});

test('search() maps a NIP-52 event with its date, location and all-day flag', async () => {
  const event = {
    id: 'e8',
    kind: KIND_CALENDAR_DATE,
    pubkey: 'f'.repeat(64),
    created_at: 1_700_000_000,
    content: '',
    tags: [
      ['d', 'meetup'],
      ['title', 'Nostr Meetup'],
      ['summary', 'Monthly gathering'],
      ['start', '2026-12-01'],
      ['location', 'Berlin'],
    ],
  };
  const contentCrawler = stubContentCrawler();
  const adapter = new Nip50Adapter(fakePool([event]), fakeConfig(), { contentCrawler });
  adapter.prober = { filterCapable: async (relays) => relays };

  const hits = await adapter.search('meetup');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].kind, 'event');
  assert.equal(hits[0].itemId, 'meetup');
  assert.equal(hits[0].startsAt, Date.UTC(2026, 11, 1) / 1000);
  assert.equal(hits[0].allDay, 1);
  assert.equal(hits[0].location, 'Berlin');
  assert.equal(contentCrawler.ingestedEvents.length, 1);
});

test('search() maps a NIP-53 live stream with its status and times', async () => {
  const event = {
    id: 'e9',
    kind: KIND_LIVE_STREAM,
    pubkey: 'a'.repeat(64),
    created_at: 1_700_000_000,
    content: '',
    tags: [
      ['d', 'stream'],
      ['title', 'Friday stream'],
      ['starts', '1700000000'],
      ['status', 'live'],
    ],
  };
  const contentCrawler = stubContentCrawler();
  const adapter = new Nip50Adapter(fakePool([event]), fakeConfig(), { contentCrawler });
  adapter.prober = { filterCapable: async (relays) => relays };

  const hits = await adapter.search('stream');
  assert.equal(hits[0].kind, 'live-stream');
  assert.equal(hits[0].liveStatus, 'live');
  assert.equal(hits[0].startsAt, 1700000000);
  assert.equal(contentCrawler.ingestedLive.length, 1);
});

test('client relays are queried for live hits but never ingested into the crawler', async () => {
  const configuredEvent = nccEvent({ id: 'configured', title: 'Configured hit' });
  const extraEvent = nccEvent({ id: 'extra', pubkey: 'b'.repeat(64), dTag: 'extra', title: 'Extra hit' });
  const queried = [];
  const pool = {
    querySync: async (relays) => {
      queried.push(relays);
      return relays.includes('wss://extra.example/') ? [extraEvent] : [configuredEvent];
    },
  };
  const nccCrawler = stubCrawler();
  const adapter = new Nip50Adapter(pool, fakeConfig(), { nccCrawler });
  adapter.prober = {
    filterCapable: async (relays) => relays,
  };

  const hits = await adapter.search('hit', { extraRelays: ['wss://extra.example'] });

  assert.equal(hits.length, 2);
  assert.deepEqual(queried, [['wss://relay.example'], ['wss://extra.example/']]);
  assert.equal(nccCrawler.ingested.length, 1, 'only the configured relay\'s event is ingested');
  assert.equal(nccCrawler.ingested[0], configuredEvent);
});

test('a relay already in NCC_SEARCH_RELAYS is not queried twice as a client relay', async () => {
  const queried = [];
  const pool = {
    querySync: async (relays) => {
      queried.push(relays);
      return [];
    },
  };
  const adapter = new Nip50Adapter(pool, fakeConfig());
  adapter.prober = { filterCapable: async (relays) => relays };

  await adapter.search('x', { extraRelays: ['wss://relay.example'] });
  assert.deepEqual(queried, [['wss://relay.example']]);
});
