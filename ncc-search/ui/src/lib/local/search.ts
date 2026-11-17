import MiniSearch from 'minisearch';

import type { SearchSort } from '@/lib/api';

import type { LocalRow } from './types';

// The nsite edition's full-text index. MiniSearch rather than SQLite/FTS5:
// the browser can't run the server's engine, and a ~10 KB inverted index over
// a capped set of rows is enough for the relay-native content this edition
// keeps. The important part is that the *contract* is the same -- the field
// boosts mirror the backend's FTS5 weights, and every explicit sort produces
// exactly the same order (including undated rows last), because those are
// applied here rather than delegated to the search engine.
const FIELDS = ['title', 'hashtags', 'description', 'body'] as const;

export class LocalSearchIndex {
  private index: MiniSearch<LocalRow>;

  constructor() {
    this.index = new MiniSearch<LocalRow>({
      idField: 'key',
      fields: [...FIELDS],
      // Nothing needs to be stored in the index: rows already live in the
      // crawler's map, and MiniSearch's hits only carry the id.
      storeFields: [],
      extractField: (row, field) => {
        if (field === 'hashtags') return row.hashtags?.join(' ') ?? '';
        const value = row[field as 'title' | 'description' | 'body'];
        return value ?? '';
      },
      searchOptions: {
        boost: { title: 4, hashtags: 2, description: 1.5 },
        prefix: true,
        fuzzy: false,
        combineWith: 'AND',
      },
    });
  }

  get size(): number {
    return this.index.documentCount;
  }

  addAll(rows: Iterable<LocalRow>): void {
    for (const row of rows) this.index.add(row);
  }

  /** Adds a new row or replaces an existing one with the same key. */
  put(row: LocalRow): void {
    if (this.index.has(row.key)) this.index.replace(row);
    else this.index.add(row);
  }

  remove(key: string): void {
    if (this.index.has(key)) this.index.discard(key);
  }

  clear(): void {
    this.index.removeAll();
  }

  /** Matching row keys and their scores, best first. */
  match(query: string): Map<string, number> {
    const scores = new Map<string, number>();
    const trimmed = query.trim();
    if (!trimmed) return scores;
    for (const result of this.index.search(trimmed)) {
      scores.set(result.id as string, result.score);
    }
    return scores;
  }
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The same orders `GET /search` implements (../src/store.js's SORT_ORDERS):
 * no-date rows last in both directions so "oldest" cannot mean "unknown",
 * and every order ends on a stable unique key so paging cannot repeat or
 * skip a row.
 */
export function sortRows(
  rows: LocalRow[],
  sort: SearchSort,
  scores: Map<string, number>,
): LocalRow[] {
  const byDate = (a: LocalRow, b: LocalRow) => (a.postedAt ?? 0) - (b.postedAt ?? 0);
  const tieBreak = (a: LocalRow, b: LocalRow) =>
    compareText(a.pubkey, b.pubkey) || compareText(a.itemId, b.itemId);

  return [...rows].sort((a, b) => {
    switch (sort) {
      case 'newest':
      case 'oldest': {
        const aMissing = a.postedAt == null;
        const bMissing = b.postedAt == null;
        if (aMissing !== bMissing) return aMissing ? 1 : -1;
        if (aMissing) return tieBreak(a, b);
        return (sort === 'newest' ? -byDate(a, b) : byDate(a, b)) || tieBreak(a, b);
      }
      case 'title':
      case 'title-desc': {
        const aTitle = a.title?.trim().toLowerCase() ?? '';
        const bTitle = b.title?.trim().toLowerCase() ?? '';
        if (!aTitle !== !bTitle) return aTitle ? -1 : 1;
        if (!aTitle) return tieBreak(a, b);
        return (sort === 'title' ? compareText(aTitle, bTitle) : compareText(bTitle, aTitle)) || tieBreak(a, b);
      }
      default: {
        const delta = (scores.get(b.key) ?? 0) - (scores.get(a.key) ?? 0);
        return delta || compareText(a.itemId, b.itemId);
      }
    }
  });
}
