import type { ResultKind } from '@/lib/api';

/**
 * One indexed event, in the shape the local index needs.
 *
 * This is the nsite edition's counterpart to a `services` row in the Node
 * crawler (../src/store.js), but deliberately smaller: there is no
 * reachability, attestation or verified-NIP-05 column because a browser
 * cannot produce one (see ui/README.md's "nsite edition"). `body` is plain
 * text for search/snippets only -- the article preview still fetches the
 * real event from relays, so nothing here is rendered as Markdown.
 *
 * `kind` uses the same `ResultKind` strings `/search` returns, so the UI
 * never needs to know which index answered.
 */
export interface LocalRow {
  /** `${kind}\u0000${pubkey}\u0000${itemId}` -- unique per result, like the server's primary key. */
  key: string;
  pubkey: string;
  itemId: string;
  kind: ResultKind;
  /** The source event's id, when it has one (every kind here does). */
  eventId: string | null;
  /** `created_at` of the source event; decides which relay's copy of a replaceable event wins. */
  eventCreatedAt: number;
  /** Unix seconds when this browser first indexed the row. */
  firstSeenAt: number;
  /** Unix seconds when the row last changed (used as the UI's `indexedAt`). */
  updatedAt: number;
  /** Unix seconds, the same rule the backend stores (shared/postedAt.js). */
  postedAt: number | null;
  /** NIP-52/NIP-53 scheduled start/end, Unix seconds. */
  startsAt?: number | null;
  endsAt?: number | null;
  /** 1 for an all-day NIP-52 date-based event. */
  allDay?: number | null;
  /** NIP-52 location (several joined for display). */
  location?: string | null;
  /** NIP-53 publisher-declared status. */
  liveStatus?: 'planned' | 'live' | 'ended' | null;
  participantCount?: number | null;
  title: string | null;
  description: string | null;
  /** Plain text, capped at BODY_LIMIT. Never rendered as Markdown. */
  body: string | null;
  endpoint: string | null;
  mediaUrl: string | null;
  mediaType: string | null;
  thumbnailUrl: string | null;
  blurhash: string | null;
  thumbhash: string | null;
  hashtags: string[] | null;
  contentWarning: string | null;
}

export interface LocalCursor {
  /** `${relay}|${filterKey}` */
  key: string;
  relay: string;
  filterKey: string;
  /** Oldest `created_at` seen so far; the next page asks for events older than this. */
  until: number | null;
  updatedAt: number;
  /** Events accepted on the most recent request for this cursor. */
  events: number;
  /** True once a relay answered with nothing older, so the crawl stops asking. */
  exhausted: boolean;
}

export interface LocalSettings {
  relays: string[];
  /** Deepest page per kind per relay (1 = newest page only). */
  depth: number;
  includeProfiles: boolean;
  maxRows: number;
  maxBytes: number;
}

export type RelayPhase = 'idle' | 'connecting' | 'connected' | 'failed';

export interface RelayStatus {
  url: string;
  state: RelayPhase;
  events: number;
  lastEventAt: number | null;
  lastError: string | null;
  failureCount: number;
}

export interface LocalCrawlStatus {
  phase: 'loading' | 'idle' | 'crawling' | 'paused' | 'error';
  /** 0..1 while `phase === 'loading'` (reading rows + building the search index). */
  loadProgress: number;
  recordCount: number;
  rowsByKind: Record<string, number>;
  relays: RelayStatus[];
  lastEventAt: number | null;
  lastSuccessfulSyncAt: number | null;
  lastFailureAt: number | null;
  /** Bumped whenever a row is added, replaced or pruned -- the UI refetches searches on change. */
  version: number;
  /** Rough IndexedDB usage in bytes, from `navigator.storage.estimate()`. */
  bytesStored: number | null;
  settings: LocalSettings;
  /** The crawl pass currently running, e.g. "articles page 2/4". */
  activity: string | null;
}

export type LocalClientMessage =
  | { type: 'start'; settings: LocalSettings; crawl: boolean }
  | { type: 'search'; id: number; query: string; limit: number; offset: number; sort: string }
  | { type: 'status' }
  | { type: 'settings'; settings: LocalSettings }
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'clear' };

export type LocalWorkerMessage =
  | { type: 'ready' }
  | { type: 'status'; status: LocalCrawlStatus }
  | { type: 'search'; id: number; response: unknown }
  | { type: 'error'; id?: number; message: string };
