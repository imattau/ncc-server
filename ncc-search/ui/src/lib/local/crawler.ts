/// <reference lib="webworker" />

import { NRelay1 } from '@nostrify/nostrify';
import type { NostrEvent, NostrFilter } from '@nostrify/nostrify';

import type { SearchSort } from '@/lib/api';

import { openDb, type LocalDb } from './db';
import { CRAWL_KINDS, eventToRow, rowKey, shouldReplace, toSearchResult } from './rows';
import { LocalSearchIndex, sortRows } from './search';
import type {
  LocalClientMessage,
  LocalCrawlStatus,
  LocalCursor,
  LocalRow,
  LocalSettings,
  LocalWorkerMessage,
  RelayStatus,
} from './types';

// The nsite edition's crawler. It does what the Node crawler does for the
// relay-native kinds -- subscribe, dedupe by (kind, pubkey, item id), keep the
// newest event, store a searchable row -- with two deliberate differences:
//
//   * it runs only while the page is open (no service worker, no background
//     process), and
//   * it never fetches endpoints, so NCC services and nsites are indexed by
//     what relays carry, not by what their hosts serve.
//
// State lives in IndexedDB so the next visit resumes from per-relay cursors
// instead of starting over.

const scope = self as unknown as DedicatedWorkerGlobalScope;

const PAGE_SIZE = 500;
const POLITE_DELAY_MS = 350;
const TASK_TIMEOUT_MS = 30_000;
const PROFILE_BATCH = 100;
const PROFILE_REFRESH_SECONDS = 7 * 24 * 60 * 60;
const FLUSH_MS = 1_200;
const STATUS_MS = 1_000;
const INDEX_CHUNK = 500;

const KIND_LABELS: Record<number, string> = {
  30023: 'articles',
  20: 'pictures',
  21: 'videos',
  22: 'short videos',
  34235: 'videos',
  34236: 'short videos',
  15128: 'sites',
  35128: 'sites',
  9900: 'packages',
  30059: 'services',
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function post(message: LocalWorkerMessage): void {
  scope.postMessage(message);
}

class Crawler {
  private db: LocalDb | null = null;
  private readonly rows = new Map<string, LocalRow>();
  private readonly cursors = new Map<string, LocalCursor>();
  private readonly rowsByKind = new Map<string, number>();
  private index: LocalSearchIndex | null = null;

  private settings: LocalSettings;
  private phase: LocalCrawlStatus['phase'] = 'loading';
  private loadProgress = 0;
  private version = 0;
  private activity: string | null = null;
  private lastEventAt: number | null = null;
  private lastSuccessfulSyncAt: number | null = null;
  private lastFailureAt: number | null = null;
  private bytesStored: number | null = null;
  private quotaBytes: number | null = null;
  private bytesCheckedAt = 0;

  private readonly relayStatuses = new Map<string, RelayStatus>();
  private readonly connections = new Map<string, NRelay1>();
  private readonly activeControllers = new Set<AbortController>();

  private paused = false;
  private runId = 0;
  private started = false;
  /** True when this tab owns the crawl lock (see ensureLeadership). */
  private hasLeadership = false;
  private leadershipAttempt: Promise<boolean> | null = null;

  private pendingWrites: LocalRow[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private statusTimer: ReturnType<typeof setInterval> | null = null;
  private dirtyStatus = false;

  private readonly pendingSearches: Array<{ message: Extract<LocalClientMessage, { type: 'search' }>; }> = [];

  constructor(settings: LocalSettings, private readonly shouldCrawl: boolean) {
    this.settings = settings;
    this.syncRelayStatuses();
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    this.db = await openDb();
    for (const row of await this.db.loadRows()) this.rows.set(row.key, row);
    for (const cursor of await this.db.loadCursors()) this.cursors.set(cursor.key, cursor);
    this.recountKinds();

    // Build the index in chunks with a yield between them: the worker is a
    // single thread, so an unbroken 20k-document index build would block the
    // status messages the page needs to show what is happening.
    this.index = new LocalSearchIndex();
    const all = [...this.rows.values()];
    for (let offset = 0; offset < all.length; offset += INDEX_CHUNK) {
      this.index.addAll(all.slice(offset, offset + INDEX_CHUNK));
      this.loadProgress = all.length === 0 ? 1 : Math.min(1, (offset + INDEX_CHUNK) / all.length);
      this.broadcastStatus();
      await sleep(0);
    }
    this.loadProgress = 1;
    this.phase = 'idle';

    this.statusTimer = setInterval(() => {
      if (this.dirtyStatus) {
        this.dirtyStatus = false;
        this.broadcastStatus();
      }
      void this.refreshBytes();
    }, STATUS_MS);

    post({ type: 'ready' });
    this.broadcastStatus();
    this.drainSearches();

    if (this.shouldCrawl) this.startCrawl();
    else this.phase = 'idle';
  }

  clear(): void {
    void this.runClear();
  }

  private async runClear(): Promise<void> {
    this.runId += 1;
    this.paused = false;
    this.closeConnections();
    try {
      await this.db?.clearAll();
    } catch {
      // A failed clear is still followed by an in-memory reset; the next
      // write will surface the real storage problem.
    }
    this.rows.clear();
    this.cursors.clear();
    this.rowsByKind.clear();
    this.index?.clear();
    this.pendingWrites = [];
    this.lastSuccessfulSyncAt = null;
    this.lastEventAt = null;
    this.lastFailureAt = null;
    this.activity = null;
    // navigator.storage.estimate() keeps reporting the space IndexedDB has
    // allocated after a clear, so leaving the old number on screen would show
    // megabytes for an empty index. Re-measure from scratch.
    this.bytesStored = 0;
    this.bytesCheckedAt = 0;
    this.version += 1;
    this.phase = 'idle';
    this.broadcastStatus();
    if (this.shouldCrawl) this.startCrawl();
  }

  pause(): void {
    this.paused = true;
    if (this.phase === 'crawling') this.phase = 'paused';
    this.broadcastStatus();
  }

  resume(): void {
    if (!this.started) return;
    this.paused = false;
    if (this.phase === 'paused' || this.phase === 'idle' || this.phase === 'error') this.startCrawl();
    else this.broadcastStatus();
  }

  updateSettings(settings: LocalSettings): void {
    this.settings = settings;
    this.syncRelayStatuses();
    this.runId += 1;
    this.closeConnections();
    this.paused = false;
    // A smaller limit has to take effect now, not on the next unrelated
    // write: lowering the cap while the page is idle should prune. Flushing
    // first means the rows this session just crawled are written (and then
    // counted) before anything is judged over the limit.
    this.bytesCheckedAt = 0;
    void (async () => {
      await this.flush();
      await this.pruneIfNeeded();
      this.startCrawl();
    })();
  }

  search(message: Extract<LocalClientMessage, { type: 'search' }>): void {
    if (!this.index) {
      this.pendingSearches.push({ message });
      return;
    }
    const sort: SearchSort = ['relevance', 'newest', 'oldest', 'title', 'title-desc'].includes(message.sort)
      ? (message.sort as SearchSort)
      : 'relevance';
    const query = message.query.trim();
    const limit = Math.min(Math.max(message.limit || 20, 1), 100);
    const offset = Math.max(message.offset || 0, 0);

    if (!query) {
      post({
        type: 'search',
        id: message.id,
        response: { query, sort, results: [], hasMore: false },
      });
      return;
    }

    const scores = this.index.match(query);
    const matches: LocalRow[] = [];
    for (const key of scores.keys()) {
      const row = this.rows.get(key);
      if (row) matches.push(row);
    }
    const sorted = sortRows(matches, sort, scores);
    const page = sorted.slice(offset, offset + limit);
    post({
      type: 'search',
      id: message.id,
      response: {
        query,
        sort,
        results: page.map((row) => toSearchResult(row, query)),
        hasMore: offset + limit < sorted.length,
      },
    });
  }

  status(): LocalCrawlStatus {
    return {
      phase: this.phase,
      loadProgress: this.loadProgress,
      recordCount: this.rows.size,
      rowsByKind: Object.fromEntries(this.rowsByKind),
      relays: [...this.relayStatuses.values()],
      lastEventAt: this.lastEventAt,
      lastSuccessfulSyncAt: this.lastSuccessfulSyncAt,
      lastFailureAt: this.lastFailureAt,
      version: this.version,
      bytesStored: this.bytesStored,
      settings: this.settings,
      activity: this.activity,
    };
  }

  private drainSearches(): void {
    const queued = this.pendingSearches.splice(0);
    for (const { message } of queued) this.search(message);
  }

  private broadcastStatus(): void {
    post({ type: 'status', status: this.status() });
  }

  private markDirty(): void {
    this.dirtyStatus = true;
  }

  private syncRelayStatuses(): void {
    const wanted = new Set(this.settings.relays);
    for (const url of [...this.relayStatuses.keys()]) {
      if (!wanted.has(url)) this.relayStatuses.delete(url);
    }
    for (const url of this.settings.relays) {
      if (!this.relayStatuses.has(url)) {
        this.relayStatuses.set(url, {
          url,
          state: 'idle',
          events: 0,
          lastEventAt: null,
          lastError: null,
          failureCount: 0,
        });
      }
    }
  }

  private connectionFor(url: string): NRelay1 {
    const existing = this.connections.get(url);
    if (existing) return existing;
    const connection = new NRelay1(url, {
      // Long idle timeout: the crawl asks each relay for many pages in a row,
      // and reconnecting between every page would be both slow and rude.
      idleTimeout: 5 * 60_000,
      backoff: false,
    });
    this.connections.set(url, connection);
    return connection;
  }

  private closeConnections(): void {
    for (const controller of this.activeControllers) controller.abort();
    this.activeControllers.clear();
    for (const connection of this.connections.values()) {
      try {
        connection.close();
      } catch {
        // already closed
      }
    }
    this.connections.clear();
    for (const status of this.relayStatuses.values()) status.state = 'idle';
  }

  /**
   * One crawling tab per site. Two tabs writing the same IndexedDB would not
   * corrupt it (rows are keyed and replaced by `created_at`), but they would
   * double the relay load for no benefit, and each tab's in-memory index would
   * only ever see its own writes. The Web Locks API is exactly this: the first
   * tab holds the lock for as long as it lives, later tabs still read and
   * search the index they loaded, and one of them takes over after the
   * crawler's tab closes.
   */
  private async ensureLeadership(): Promise<boolean> {
    if (this.hasLeadership) return true;
    if (typeof navigator === 'undefined' || !navigator.locks?.request) {
      this.hasLeadership = true;
      return true;
    }
    if (this.leadershipAttempt) return this.leadershipAttempt;

    const attempt = new Promise<boolean>((resolve) => {
      void navigator.locks.request('ncc-search-crawler', { ifAvailable: true }, (lock) => {
        if (!lock) {
          resolve(false);
          return;
        }
        this.hasLeadership = true;
        resolve(true);
        // Hold the lock for the life of the worker: returning a promise that
        // never settles is the documented way to keep it.
        return new Promise<void>(() => {});
      });
    });
    this.leadershipAttempt = attempt;
    const acquired = await attempt;
    this.leadershipAttempt = null;
    return acquired;
  }

  private startCrawl(): void {
    if (!this.hasLeadership) {
      void this.ensureLeadership().then((acquired) => {
        if (!acquired) {
          this.phase = 'paused';
          this.activity = 'another tab is crawling this site';
          this.broadcastStatus();
          return;
        }
        this.startCrawl();
      });
      return;
    }
    this.runId += 1;
    const runId = this.runId;
    this.phase = 'crawling';
    this.broadcastStatus();
    void this.crawl(runId).catch((error: unknown) => {
      if (runId !== this.runId) return;
      this.phase = 'error';
      this.activity = error instanceof Error ? error.message : String(error);
      this.lastFailureAt = Date.now();
      this.broadcastStatus();
    });
  }

  /** Resolves true when this run should stop (paused is handled by waiting). */
  private async gate(runId: number): Promise<boolean> {
    while (this.paused && runId === this.runId) await sleep(400);
    return runId !== this.runId;
  }

  /**
   * The configured limit, never more than half the browser's own quota. A
   * reader can pick 150 MB, but a device that only grants 200 MB must not be
   * filled to the point where the app's own assets and other storage are at
   * risk.
   */
  private effectiveMaxBytes(): number {
    const quotaLimit = this.quotaBytes != null ? Math.floor(this.quotaBytes / 2) : Number.POSITIVE_INFINITY;
    return Math.min(this.settings.maxBytes, quotaLimit);
  }

  private overCap(): boolean {
    if (this.rows.size >= this.settings.maxRows) return true;
    return this.bytesStored != null && this.bytesStored >= this.effectiveMaxBytes();
  }

  private async crawl(runId: number): Promise<void> {
    if (await this.gate(runId)) return;

    // Newest page first, for every kind on every relay, before going deeper:
    // a first run should produce something searchable in seconds even if the
    // user closes the tab after a minute.
    for (let page = 0; page < this.settings.depth; page += 1) {
      for (const kind of CRAWL_KINDS) {
        for (const relay of this.settings.relays) {
          if (this.overCap()) return this.finish(runId);
          if (await this.gate(runId)) return;
          const filterKey = `kind:${kind}`;
          const cursor = this.cursors.get(this.cursorKey(relay, filterKey));
          if (cursor?.exhausted) continue;
          this.activity = `${KIND_LABELS[kind] ?? `kind ${kind}`} · page ${page + 1}/${this.settings.depth}`;
          this.markDirty();
          await this.runTask(runId, relay, filterKey, {
            kinds: [kind],
            limit: PAGE_SIZE,
            ...(cursor?.until != null ? { until: cursor.until } : {}),
          });
          await sleep(POLITE_DELAY_MS);
        }
      }
      await this.flush();
    }

    if (this.settings.includeProfiles && !this.overCap()) await this.crawlProfiles(runId);
    this.finish(runId);
  }

  private finish(runId: number): void {
    if (runId !== this.runId) return;
    this.activity = null;
    this.phase = 'idle';
    this.lastSuccessfulSyncAt = Date.now();
    void this.flush().then(() => this.broadcastStatus());
  }

  private async crawlProfiles(runId: number): Promise<void> {
    const cutoff = Math.floor(Date.now() / 1000) - PROFILE_REFRESH_SECONDS;
    const authors = [...new Set(
      [...this.rows.values()]
        .filter((row) => row.kind !== 'profile')
        .map((row) => row.pubkey),
    )].filter((pubkey) => {
      const profile = this.rows.get(rowKey('profile', pubkey, '_profile'));
      return !profile || profile.updatedAt < cutoff;
    });

    for (let offset = 0; offset < authors.length; offset += PROFILE_BATCH) {
      if (this.overCap()) return;
      if (await this.gate(runId)) return;
      const batch = authors.slice(offset, offset + PROFILE_BATCH);
      this.activity = `profiles · ${Math.min(offset + PROFILE_BATCH, authors.length)}/${authors.length}`;
      this.markDirty();

      for (const relay of this.settings.relays) {
        if (await this.gate(runId)) return;
        await this.runTask(runId, relay, 'profiles', {
          kinds: [0],
          authors: batch,
          limit: batch.length,
        });
        await sleep(POLITE_DELAY_MS);
        // Most relays carry most profiles; once a batch is mostly resolved,
        // asking the remaining relays just burns their rate limit for a
        // handful of names.
        const resolved = batch.filter((pubkey) =>
          this.rows.has(rowKey('profile', pubkey, '_profile')),
        ).length;
        if (resolved >= batch.length * 0.8) break;
      }
      await this.flush();
    }
  }

  private cursorKey(relay: string, filterKey: string): string {
    return `${relay}|${filterKey}`;
  }

  private async runTask(
    runId: number,
    relay: string,
    filterKey: string,
    filter: NostrFilter,
  ): Promise<void> {
    if (runId !== this.runId) return;
    const status = this.relayStatuses.get(relay);
    if (!status) return;

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, TASK_TIMEOUT_MS);
    let events = 0;
    let oldest: number | null = null;
    let closedReason: string | null = null;
    let sawEose = false;

    status.state = 'connecting';
    this.markDirty();
    this.activeControllers.add(controller);

    try {
      for await (const message of this.connectionFor(relay).req([filter], { signal: controller.signal })) {
        if (message[0] === 'EVENT') {
          events += 1;
          const event = message[2] as NostrEvent;
          if (Number.isFinite(event.created_at)) {
            oldest = oldest == null ? event.created_at : Math.min(oldest, event.created_at);
          }
          this.ingest(event);
        } else if (message[0] === 'EOSE') {
          // NRelay1 ends the generator on EOSE (and silently on CLOSED), so
          // an EOSE is the only proof the relay finished answering rather
          // than refusing. See the post-loop check below.
          sawEose = true;
          break;
        } else if (message[0] === 'CLOSED') {
          closedReason = message[2] || 'closed by relay';
          break;
        }
      }
      if (!sawEose && !closedReason) closedReason = 'subscription closed by relay';
      if (!closedReason) {
        status.state = 'connected';
        status.lastError = null;
        status.events += events;
        if (events > 0) {
          status.lastEventAt = Date.now();
          this.lastEventAt = Date.now();
          this.lastSuccessfulSyncAt = Date.now();
        }
      }
    } catch (error) {
      // A settings change or a clear aborts in-flight requests; that is not
      // the relay failing, and it should not be counted as one.
      if (runId === this.runId && !timedOut) {
        status.state = 'failed';
        status.failureCount += 1;
        status.lastError = controller.signal.aborted
          ? 'timed out'
          : error instanceof Error
            ? error.message
            : String(error);
        this.lastFailureAt = Date.now();
      }
    } finally {
      this.activeControllers.delete(controller);
      clearTimeout(timer);
    }

    // A timeout (or a local cancellation from pause/settings/clear) did not
    // produce a complete page. In particular, an empty partial response must
    // never advance the cursor or mark this relay/filter exhausted.
    if (timedOut || runId !== this.runId) {
      if (timedOut && runId === this.runId) {
        status.state = 'failed';
        status.failureCount += 1;
        status.lastError = 'timed out';
        this.lastFailureAt = Date.now();
      }
      this.markDirty();
      return;
    }

    if (closedReason) {
      status.state = 'failed';
      status.failureCount += 1;
      status.lastError = closedReason;
      this.lastFailureAt = Date.now();
      // A CLOSED answer is a refusal, not an empty result: backing off also
      // keeps a rate-limited relay from being asked the same question again
      // on the very next task.
      await sleep(Math.min(30_000, 2_000 * status.failureCount));
      return;
    }

    const key = this.cursorKey(relay, filterKey);
    const previous = this.cursors.get(key);
    const cursor: LocalCursor = {
      key,
      relay,
      filterKey,
      until: oldest == null ? (previous?.until ?? null) : Math.min(previous?.until ?? oldest, oldest) - 1,
      updatedAt: Date.now(),
      events,
      exhausted: events === 0,
    };
    this.cursors.set(key, cursor);
    await this.saveCursor(cursor);
    this.markDirty();
  }

  private async saveCursor(cursor: LocalCursor): Promise<void> {
    try {
      await this.db?.putCursors([cursor]);
    } catch {
      // Cursors are an optimization: losing one costs a repeated page, not
      // the index itself.
    }
  }

  private ingest(event: NostrEvent): void {
    const now = Math.floor(Date.now() / 1000);

    // Profile events are re-requested on a cadence (see crawlProfiles), and an
    // unchanged kind:0 must not look like a new event forever: mark it seen so
    // the next 7-day window starts from this visit, without touching the
    // search index or pretending the profile changed.
    if (event.kind === 0) {
      const existing = this.rows.get(rowKey('profile', event.pubkey, '_profile'));
      if (existing && existing.eventCreatedAt >= (event.created_at ?? 0)) {
        if (now - existing.updatedAt > 60) {
          existing.updatedAt = now;
          this.pendingWrites.push(existing);
          this.scheduleFlush();
        }
        return;
      }
    }

    const row = eventToRow(event, now);
    if (!row) return;

    const existing = this.rows.get(row.key);
    if (!shouldReplace(existing, row)) return;
    if (existing) row.firstSeenAt = existing.firstSeenAt;

    this.index?.put(row);
    if (!existing) this.rowsByKind.set(row.kind, (this.rowsByKind.get(row.kind) ?? 0) + 1);
    this.rows.set(row.key, row);
    this.pendingWrites.push(row);
    this.version += 1;
    this.markDirty();

    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.pendingWrites.length >= 200) void this.flush();
    else if (this.flushTimer == null) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        void this.flush();
      }, FLUSH_MS);
    }
  }

  private async flush(): Promise<void> {
    if (this.flushTimer != null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    const writes = this.pendingWrites.splice(0);
    if (writes.length === 0) return;
    try {
      await this.db?.putRows(writes);
    } catch {
      // Losing a batch means those rows are re-crawled next session; the
      // in-memory index still serves them for this one.
    }
    await this.pruneIfNeeded();
    this.broadcastStatus();
  }

  private async pruneIfNeeded(): Promise<void> {
    await this.refreshBytes();
    const overRows = this.rows.size > this.settings.maxRows;
    const overBytes = this.bytesStored != null && this.bytesStored > this.effectiveMaxBytes();
    if (!overRows && !overBytes) return;

    const candidates = [...this.rows.values()].sort((a, b) => {
      const aDate = a.postedAt ?? a.firstSeenAt;
      const bDate = b.postedAt ?? b.firstSeenAt;
      return aDate - bDate;
    });
    // Drop 10% past the cap, not one row: pruning on every ingest would turn
    // a crawl into a stream of tiny deletes. The byte cap uses the same 10%,
    // because rows are not what is filling the quota (one long article can
    // cost more than a hundred short rows).
    const target = Math.ceil(this.settings.maxRows * 0.9);
    const dropCount = Math.max(1, this.rows.size - target, Math.ceil(this.rows.size * 0.1));
    const dropped = candidates.slice(0, dropCount);
    for (const row of dropped) {
      this.rows.delete(row.key);
      this.index?.remove(row.key);
      const count = this.rowsByKind.get(row.kind) ?? 0;
      if (count <= 1) this.rowsByKind.delete(row.kind);
      else this.rowsByKind.set(row.kind, count - 1);
    }
    try {
      await this.db?.deleteRows(dropped.map((row) => row.key));
      // Cursors keep pointing at the oldest event seen, so the crawl does not
      // re-fetch what was just pruned -- it continues from where it was.
    } catch {
      // The rows are gone from memory either way; a failed delete is retried
      // by the next prune.
    }
    this.version += 1;
    this.markDirty();
  }

  private async refreshBytes(): Promise<void> {
    const now = Date.now();
    if (now - this.bytesCheckedAt < 15_000) return;
    this.bytesCheckedAt = now;
    try {
      const estimate = await navigator.storage?.estimate?.();
      if (estimate?.usage != null) this.bytesStored = estimate.usage;
      if (estimate?.quota != null) this.quotaBytes = estimate.quota;
    } catch {
      // Not available in every context; the row cap still applies.
    }
  }

  private recountKinds(): void {
    this.rowsByKind.clear();
    for (const row of this.rows.values()) {
      this.rowsByKind.set(row.kind, (this.rowsByKind.get(row.kind) ?? 0) + 1);
    }
  }
}

let crawler: Crawler | null = null;

scope.addEventListener('message', (event: MessageEvent<LocalClientMessage>) => {
  const message = event.data;
  if (!message || typeof message !== 'object') return;

  if (message.type === 'start') {
    if (crawler) return;
    crawler = new Crawler(message.settings, message.crawl);
    void crawler.start().catch((error: unknown) => {
      post({
        type: 'error',
        message: error instanceof Error ? error.message : String(error),
      });
    });
    return;
  }

  if (!crawler) return;

  switch (message.type) {
    case 'search':
      crawler.search(message);
      break;
    case 'status':
      post({ type: 'status', status: crawler.status() });
      break;
    case 'settings':
      crawler.updateSettings(message.settings);
      break;
    case 'pause':
      crawler.pause();
      break;
    case 'resume':
      crawler.resume();
      break;
    case 'clear':
      crawler.clear();
      break;
  }
});
