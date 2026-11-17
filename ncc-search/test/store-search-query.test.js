import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, KIND_ARTICLE, KIND_PROFILE } from '../src/store.js';

function freshStore() {
  const dir = mkdtempSync(join(tmpdir(), 'ncc-search-store-search-query-test-'));
  const store = openStore(join(dir, 'test.db'));
  return { store, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('search() matches on a prefix of the final word (search-as-you-type)', () => {
  const { store, cleanup } = freshStore();
  try {
    store.upsertContent({
      pubkey: 'a'.repeat(64), itemId: 'wallet-guide', kind: KIND_ARTICLE,
      title: 'Wallet security basics', description: null, body: 'Key management guide.',
    });

    assert.equal(store.search('wall')[0]?.itemId, 'wallet-guide');
    assert.equal(store.search('wallet sec')[0]?.itemId, 'wallet-guide');
  } finally {
    cleanup();
  }
});

test('search() treats FTS5 syntax characters in the query as literal text instead of erroring', () => {
  const { store, cleanup } = freshStore();
  try {
    store.upsertContent({
      pubkey: 'a'.repeat(64), itemId: 'nip05-doc', kind: KIND_ARTICLE,
      title: 'NIP-05 verification', description: null, body: 'How name@domain lookups work.',
    });

    // ":" and "-" are FTS5 query syntax; previously passed straight through
    // to MATCH, a raw colon would throw "fts5: syntax error".
    assert.doesNotThrow(() => store.search('http://example.com'));
    assert.doesNotThrow(() => store.search('col:value'));
    assert.equal(store.search('NIP-05')[0]?.itemId, 'nip05-doc');
  } finally {
    cleanup();
  }
});

test('search() on an empty/whitespace-only query returns no results rather than erroring', () => {
  const { store, cleanup } = freshStore();
  try {
    assert.deepEqual(store.search(''), []);
    assert.deepEqual(store.search('   '), []);
  } finally {
    cleanup();
  }
});

test('search() breaks a bm25 tie in favor of an anchored, attested, recently-reachable result', () => {
  const { store, cleanup } = freshStore();
  try {
    const now = Math.floor(Date.now() / 1000);
    store.upsertService(
      {
        pubkey: 'a'.repeat(64), serviceId: 'plain', endpoint: 'https://plain.example',
        fingerprint: 'f1', family: 'f', anchored: false, usedFallback: false,
        attestationCount: 0, isRevoked: false, ttlSeconds: null,
      },
      { status: 200, title: 'Example service', description: 'A demo service.' },
    );
    store.upsertService(
      {
        pubkey: 'b'.repeat(64), serviceId: 'trusted', endpoint: 'https://trusted.example',
        fingerprint: 'f2', family: 'f', anchored: true, usedFallback: false,
        attestationCount: 5, isRevoked: false, ttlSeconds: null,
      },
      { status: 200, title: 'Example service', description: 'A demo service.' },
    );
    // Force a fresh last_reachable_at for the trusted row too (both were
    // just upserted "now", so this only documents the signal is wired in).
    void now;

    const results = store.search('example service');
    assert.equal(results.length, 2);
    assert.equal(results[0].itemId, 'trusted', 'anchored + attested + reachable result should rank first on a tie');
  } finally {
    cleanup();
  }
});

test('search() does not let the tiebreak boost override a clearly stronger text match', () => {
  const { store, cleanup } = freshStore();
  try {
    store.upsertContent({
      pubkey: 'a'.repeat(64), itemId: 'exact-title', kind: KIND_ARTICLE,
      title: 'Solar mapping project', description: null, body: 'Satellite imagery notes.',
    });
    store.upsertService(
      {
        pubkey: 'b'.repeat(64), serviceId: 'unrelated', endpoint: 'https://unrelated.example',
        fingerprint: 'f3', family: 'f', anchored: true, usedFallback: false,
        attestationCount: 5, isRevoked: false, ttlSeconds: null,
      },
      { status: 200, title: 'Completely different thing', description: 'Mentions solar once in passing.' },
    );

    const results = store.search('solar mapping');
    assert.equal(results[0].itemId, 'exact-title', 'a true title match beats a trusted but weak match');
  } finally {
    cleanup();
  }
});

function datedArticle(pubkey, itemId, title, postedAt) {
  return {
    pubkey,
    itemId,
    kind: KIND_ARTICLE,
    title,
    description: null,
    body: 'shared search term',
    postedAt,
  };
}

test('search() exposes postedAt in milliseconds and sorts by it, undated rows last either way', () => {
  const { store, cleanup } = freshStore();
  try {
    store.upsertContent(datedArticle('a'.repeat(64), 'old', 'Old post', 1_600_000_000));
    store.upsertContent(datedArticle('b'.repeat(64), 'new', 'New post', 1_700_000_000));
    // Profiles have no posting date by design (see store.js's schema comment).
    store.upsertContent({
      pubkey: 'c'.repeat(64), itemId: '_profile', kind: KIND_PROFILE,
      title: 'Undated profile', description: null, body: 'shared search term',
    });

    const ids = (sort) => store.search('shared', 10, 0, sort).map((row) => row.itemId);

    assert.deepEqual(ids('newest'), ['new', 'old', '_profile']);
    assert.deepEqual(ids('oldest'), ['old', 'new', '_profile']);
    assert.equal(store.search('shared', 10, 0, 'newest')[0].postedAt, 1_700_000_000_000);
    assert.equal(store.search('shared', 10, 0, 'newest')[2].postedAt, null);
  } finally {
    cleanup();
  }
});

test('search() sorts by title, case-insensitively, with untitled rows last', () => {
  const { store, cleanup } = freshStore();
  try {
    store.upsertContent(datedArticle('a'.repeat(64), 'lower', 'beta guide', 1_700_000_000));
    store.upsertContent(datedArticle('b'.repeat(64), 'upper', 'Alpha guide', 1_600_000_000));
    store.upsertContent(datedArticle('c'.repeat(64), 'last', 'gamma guide', 1_650_000_000));
    store.upsertContent({
      pubkey: 'd'.repeat(64), itemId: 'untitled', kind: KIND_ARTICLE,
      title: null, description: null, body: 'shared search term',
    });

    const ids = (sort) => store.search('shared', 10, 0, sort).map((row) => row.itemId);

    assert.deepEqual(ids('title'), ['upper', 'lower', 'last', 'untitled']);
    assert.deepEqual(ids('title-desc'), ['last', 'lower', 'upper', 'untitled']);
    // An unknown sort still returns relevance order rather than throwing.
    assert.equal(store.search('shared', 10, 0, 'bogus').length, 4);
  } finally {
    cleanup();
  }
});
