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

/**
 * Relays for the main thread's read-only pool (profile names, article
 * previews, quoted notes). In the nsite edition these follow the crawl
 * settings, so a user who adds a relay gets names and previews from it too,
 * rather than the page having two unrelated relay lists.
 */
export function uiRelays(): string[] {
  const configured = window.NCC_SEARCH_RELAYS_B64
    ? atob(window.NCC_SEARCH_RELAYS_B64)
    : import.meta.env.VITE_NCC_SEARCH_RELAYS ?? '';
  const explicit = normalizeRelays(configured.split(','));
  if (explicit.length) return explicit;
  return loadSettings().relays;
}
