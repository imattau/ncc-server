import type { LocalCursor, LocalRow } from './types';

// Persistence for the nsite edition. IndexedDB (not CacheStorage) because the
// index is rows, and the point is that they survive a reload: a returning
// reader gets the index they built last time and the crawl resumes from its
// cursors instead of starting over.
//
// The database is small by construction (the crawler enforces row/byte caps),
// so it is read entirely into memory at startup. That sounds crude for a
// search engine, but the search index has to hold the text anyway; keeping one
// copy of rows plus MiniSearch's structures is less memory than a streaming
// design that re-reads IndexedDB on every query.
const DB_NAME = 'ncc-search-local';
const DB_VERSION = 1;
const ROWS = 'rows';
const CURSORS = 'cursors';
const META = 'meta';

export interface LocalDb {
  loadRows(): Promise<LocalRow[]>;
  putRows(rows: LocalRow[]): Promise<void>;
  deleteRows(keys: string[]): Promise<void>;
  clearAll(): Promise<void>;
  loadCursors(): Promise<LocalCursor[]>;
  putCursors(cursors: LocalCursor[]): Promise<void>;
  clearCursors(): Promise<void>;
  getMeta<T>(key: string): Promise<T | undefined>;
  setMeta(key: string, value: unknown): Promise<void>;
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}

export function openDb(factory: IDBFactory = indexedDB): Promise<LocalDb> {
  return new Promise((resolve, reject) => {
    const open = factory.open(DB_NAME, DB_VERSION);
    open.onupgradeneeded = () => {
      const db = open.result;
      if (!db.objectStoreNames.contains(ROWS)) db.createObjectStore(ROWS, { keyPath: 'key' });
      if (!db.objectStoreNames.contains(CURSORS)) db.createObjectStore(CURSORS, { keyPath: 'key' });
      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META);
    };
    open.onerror = () => reject(open.error ?? new Error('Could not open the local index'));
    open.onsuccess = () => {
      const db = open.result;
      // Another tab publishing a new schema generation must not leave this
      // one holding an outdated connection forever; the next request would
      // otherwise fail with a VersionError after a reload.
      db.onversionchange = () => db.close();

      const dbApi: LocalDb = {
        async loadRows() {
          const tx = db.transaction(ROWS, 'readonly');
          return request(tx.objectStore(ROWS).getAll());
        },
        async putRows(rows) {
          if (rows.length === 0) return;
          const tx = db.transaction(ROWS, 'readwrite');
          const store = tx.objectStore(ROWS);
          for (const row of rows) store.put(row);
          await transactionDone(tx);
        },
        async deleteRows(keys) {
          if (keys.length === 0) return;
          const tx = db.transaction(ROWS, 'readwrite');
          const store = tx.objectStore(ROWS);
          for (const key of keys) store.delete(key);
          await transactionDone(tx);
        },
        async clearAll() {
          const tx = db.transaction([ROWS, CURSORS, META], 'readwrite');
          tx.objectStore(ROWS).clear();
          tx.objectStore(CURSORS).clear();
          tx.objectStore(META).clear();
          await transactionDone(tx);
        },
        async loadCursors() {
          const tx = db.transaction(CURSORS, 'readonly');
          return request(tx.objectStore(CURSORS).getAll());
        },
        async putCursors(cursors) {
          if (cursors.length === 0) return;
          const tx = db.transaction(CURSORS, 'readwrite');
          const store = tx.objectStore(CURSORS);
          for (const cursor of cursors) store.put(cursor);
          await transactionDone(tx);
        },
        async clearCursors() {
          const tx = db.transaction(CURSORS, 'readwrite');
          tx.objectStore(CURSORS).clear();
          await transactionDone(tx);
        },
        async getMeta(key) {
          const tx = db.transaction(META, 'readonly');
          return request(tx.objectStore(META).get(key));
        },
        async setMeta(key, value) {
          const tx = db.transaction(META, 'readwrite');
          tx.objectStore(META).put(value, key);
          await transactionDone(tx);
        },
      };
      resolve(dbApi);
    };
  });
}
