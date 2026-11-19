import type { LocalSettings } from './types';

declare global {
  interface Window {
    /** A relay list baked into runtime-config.js by the deployment. */
    NCC_SEARCH_RELAYS_B64?: string;
  }
}

// Settings live in the page's localStorage, not IndexedDB: they are tiny,
// synchronous to read (the relay pool on the main thread also needs them), and
// losing them costs nothing but a re-crawl with the defaults.
const STORAGE_KEY = 'ncc-search:local-settings:v1';

export const DEFAULT_RELAYS = [
  'wss://relay.primal.net',
  'wss://relay.ditto.pub',
  'wss://nos.lol',
];

/**
 * How much room the local index may take. Chosen in megabytes because that is
 * the number a reader can reason about (and the one the browser evicts or
 * complains about); the row cap is derived from it, since a row is roughly
 * 1-2 KB of text between the stored copy and the search index. The default is
 * the useful relay-native part of the deployed index -- the server spends most
 * of its 250k rows on profiles.
 */
export const MAX_BYTES_OPTIONS = [
  { bytes: 10 * 1024 * 1024, label: '10 MB' },
  { bytes: 25 * 1024 * 1024, label: '25 MB' },
  { bytes: 40 * 1024 * 1024, label: '40 MB' },
  { bytes: 80 * 1024 * 1024, label: '80 MB' },
  { bytes: 150 * 1024 * 1024, label: '150 MB' },
] as const;

const MIN_MAX_BYTES = 5 * 1024 * 1024;
const MAX_MAX_BYTES = 250 * 1024 * 1024;
/** Observed average: 7.7k rows of mixed content was ~9 MB of IndexedDB. */
const BYTES_PER_ROW_ESTIMATE = 2 * 1024;
const MAX_ROWS = 60_000;

export function deriveMaxRows(maxBytes: number): number {
  return Math.min(MAX_ROWS, Math.max(2_000, Math.round(maxBytes / BYTES_PER_ROW_ESTIMATE)));
}

export const DEFAULT_SETTINGS: LocalSettings = {
  relays: DEFAULT_RELAYS,
  depth: 4,
  includeProfiles: true,
  maxRows: deriveMaxRows(40 * 1024 * 1024),
  maxBytes: 40 * 1024 * 1024,
};

export function normalizeRelays(values: unknown): string[] {
  const list = Array.isArray(values) ? values : [];
  const seen = new Set<string>();
  const relays: string[] = [];
  for (const value of list) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim().replace(/\/+$/, '');
    if (!trimmed) continue;
    let url: URL;
    try {
      url = new URL(trimmed);
    } catch {
      continue;
    }
    if (url.protocol !== 'wss:' && url.protocol !== 'ws:') continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    relays.push(trimmed);
    if (relays.length >= 6) break;
  }
  return relays;
}

/** Parses a textarea's comma/whitespace/newline separated relay list. */
export function parseRelayInput(input: string): string[] {
  return normalizeRelays(input.split(/[\s,]+/));
}

export function normalizeSettings(input: Partial<LocalSettings> | null | undefined): LocalSettings {
  const relays = normalizeRelays(input?.relays);
  const depth = Number(input?.depth);
  const bytes = Number(input?.maxBytes);
  const maxBytes = Number.isFinite(bytes)
    ? Math.min(MAX_MAX_BYTES, Math.max(MIN_MAX_BYTES, Math.round(bytes)))
    : DEFAULT_SETTINGS.maxBytes;
  return {
    relays: relays.length ? relays : DEFAULT_RELAYS,
    depth: Number.isFinite(depth) ? Math.min(10, Math.max(1, Math.round(depth))) : DEFAULT_SETTINGS.depth,
    includeProfiles: input?.includeProfiles !== false,
    // Always derived rather than trusted: a stored row cap from an older
    // build must not disagree with the size the reader just chose.
    maxRows: deriveMaxRows(maxBytes),
    maxBytes,
  };
}

export function loadSettings(): LocalSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    return normalizeSettings(JSON.parse(raw));
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function saveSettings(settings: LocalSettings): LocalSettings {
  const normalized = normalizeSettings(settings);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized));
  } catch {
    // Storage can be unavailable in a private tab; the crawl still works for
    // this session with whatever settings were passed in.
  }
  return normalized;
}

// --- relay source (site defaults vs the signed-in user's NIP-65 list) ------
//
// Kept separate from LocalSettings because server-hosted builds have no local
// crawl settings at all, yet the same "use my relay list" preference applies
// to their browser-side lookups and live-search fan-out. The previous site
// list is stored alongside the NIP-65 list so switching back is lossless; the
// nsite edition writes the effective list into LocalSettings when it changes.
const RELAY_SOURCE_KEY = 'ncc-search:relay-source:v1';

export type RelaySource = 'site' | 'nip65';

export interface RelayPreference {
  source: RelaySource;
  /** The pubkey whose NIP-65 list `relays` came from. */
  pubkey: string | null;
  /** Cached read relays from kind:10002 when `source` is nip65. */
  relays: string[];
  /** The site/default list to restore when switching back. */
  siteRelays: string[];
}

/** The relays this build/deployment is configured with, ignoring any nip65 choice. */
export function siteRelays(): string[] {
  const configured = window.NCC_SEARCH_RELAYS_B64
    ? atob(window.NCC_SEARCH_RELAYS_B64)
    : import.meta.env.VITE_NCC_SEARCH_RELAYS ?? '';
  const explicit = normalizeRelays(configured.split(','));
  if (explicit.length) return explicit;
  return loadSettings().relays;
}

export function loadRelayPreference(): RelayPreference | null {
  try {
    const raw = localStorage.getItem(RELAY_SOURCE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<RelayPreference>;
    if (parsed?.source !== 'site' && parsed?.source !== 'nip65') return null;
    return {
      source: parsed.source,
      pubkey: typeof parsed.pubkey === 'string' ? parsed.pubkey : null,
      relays: normalizeRelays(parsed.relays),
      siteRelays: normalizeRelays(parsed.siteRelays ?? []),
    };
  } catch {
    return null;
  }
}

export function saveRelayPreference(preference: RelayPreference): RelayPreference {
  const normalized: RelayPreference = {
    source: preference.source,
    pubkey: preference.pubkey,
    relays: normalizeRelays(preference.relays),
    siteRelays: normalizeRelays(preference.siteRelays),
  };
  try {
    localStorage.setItem(RELAY_SOURCE_KEY, JSON.stringify(normalized));
  } catch {
    // Same as settings: the choice still applies for this session.
  }
  return normalized;
}

export function clearRelayPreference(): void {
  try {
    localStorage.removeItem(RELAY_SOURCE_KEY);
  } catch {
    // Nothing to clean up if storage is unavailable.
  }
}

/** The relays currently in effect, NIP-65 choice included. */
export function activeRelays(): string[] {
  const preference = loadRelayPreference();
  if (preference?.source === 'nip65' && preference.relays.length) return preference.relays;
  return siteRelays();
}

/**
 * Relays for the main thread's read-only pool (profile names, article
 * previews, quoted notes). These follow the relay-source preference, so a
 * reader who switches to their NIP-65 list gets names and previews from it
 * too, rather than the page having two unrelated relay lists.
 */
export function uiRelays(): string[] {
  return activeRelays();
}
