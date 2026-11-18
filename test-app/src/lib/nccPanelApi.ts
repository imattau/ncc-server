/**
 * Client for the node's admin API.
 *
 * The sidecar keeps the admin list and the node settings, and is the only
 * component that can change them. Caddy publishes it at /ncc-api/* on the
 * admin listener, and every call is signed with NIP-98 by the connected key
 * (see nip98.ts).
 *
 * Requests are relative so NCC Browser maps them to the admin service origin
 * (`ncc://<npub>.admin`); an absolute https URL would bypass the protocol
 * handler. The signed URL still has to be absolute, so an ncc:// page takes it
 * from the `panelApi` field the node serves in /ncc-config.json.
 */

import { nip98Authorization, type Nip98Method, type PanelSigner } from './nip98';
import {
  buildPanelSnapshot,
  normalizeRelay,
  type PanelSnapshot,
  type RelayReport,
} from './nccPanel';
import type { NostrEvent } from 'nostr-tools';

export interface PanelAdmin {
  pubkey: string;
  npub: string;
  status: string;
  createdAt: string | null;
}

export interface PanelAdminResult {
  admins: PanelAdmin[];
  added?: boolean;
  removed?: boolean;
  inviteSent?: boolean;
}

export interface PanelIdentity {
  name: string;
  displayName: string;
  about: string;
  picture: string;
  nip05: string;
}

export interface PanelCadence {
  refreshIntervalMinutes: number;
  ncc02ExpiryDays: number;
  ncc05TtlHours: number;
}

export interface PanelSettings {
  operator: {
    pubkey: string | null;
    npub: string | null;
  };
  relays: string[];
  identity: PanelIdentity & { published: boolean };
  cadence: PanelCadence;
  publication: {
    services: number;
    lastPublishedAt: number | null;
  };
}

export class PanelApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'PanelApiError';
    this.status = status;
  }
}

function httpBase(value: string | null | undefined): string | null {
  if (!value) return null;

  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    if (!url.hostname) return null;
    return url.toString().replace(/\/+$/, '');
  } catch {
    return null;
  }
}

/**
 * Absolute base for the signed URL.
 *
 * On http(s) the page's own origin is authoritative. Under ncc:// it is the
 * endpoint the node published, which the page itself cannot see.
 */
export function resolvePanelApiBase(panelApi: string | null | undefined): string | null {
  if (typeof window !== 'undefined') {
    const { protocol, origin } = window.location;
    if (protocol === 'http:' || protocol === 'https:') return `${origin}/ncc-api`;
  }

  return httpBase(panelApi);
}

/** Turn what an operator typed into a relay URL, or null when it is invalid. */
export function relayInputToUrl(value: string): string | null {
  let candidate = value.trim();
  if (!candidate) return null;

  if (/^https?:\/\//i.test(candidate)) {
    candidate = candidate.replace(/^https?:\/\//i, (match) => (
      match.toLowerCase() === 'https://' ? 'wss://' : 'ws://'
    ));
  } else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate)) {
    // A different scheme (ftp://, nostr://…) is not a relay URL; reject it
    // instead of turning it into wss://ftp//…
    if (!/^wss?:\/\//i.test(candidate)) return null;
  } else {
    candidate = `wss://${candidate}`;
  }

  try {
    const parsed = new URL(candidate);
    if (parsed.username || parsed.password || parsed.search || parsed.hash) return null;
  } catch {
    return null;
  }

  return normalizeRelay(candidate);
}

export const CADENCE_LIMITS: Record<keyof PanelCadence, { min: number; max: number }> = {
  refreshIntervalMinutes: { min: 5, max: 10080 },
  ncc02ExpiryDays: { min: 1, max: 365 },
  ncc05TtlHours: { min: 1, max: 720 },
};

/**
 * Why these cadence values cannot be saved, or null when they can.
 *
 * A record must outlive the interval between publishes; otherwise it expires
 * before the node replaces it and clients see a gap.
 */
export function cadenceProblem(cadence: PanelCadence): string | null {
  for (const [key, limits] of Object.entries(CADENCE_LIMITS) as [keyof PanelCadence, { min: number; max: number }][]) {
    const value = cadence[key];
    if (!Number.isInteger(value) || value < limits.min || value > limits.max) {
      return `${key} must be a whole number between ${limits.min} and ${limits.max}`;
    }
  }

  if (cadence.ncc05TtlHours * 60 <= cadence.refreshIntervalMinutes) {
    return 'Locator TTL must be longer than the publish interval, or records expire before they are refreshed.';
  }
  if (cadence.ncc02ExpiryDays * 1440 <= cadence.refreshIntervalMinutes) {
    return 'Service record expiry must be longer than the publish interval, or records expire before they are refreshed.';
  }

  return null;
}

function readAdmin(value: unknown): PanelAdmin | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;

  if (typeof record.pubkey !== 'string' || !/^[0-9a-f]{64}$/i.test(record.pubkey)) return null;
  if (typeof record.npub !== 'string' || !record.npub.startsWith('npub1')) return null;

  return {
    pubkey: record.pubkey.toLowerCase(),
    npub: record.npub,
    status: typeof record.status === 'string' ? record.status : 'active',
    createdAt: typeof record.createdAt === 'string' ? record.createdAt : null,
  };
}

function readResult(payload: unknown): PanelAdminResult {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new PanelApiError(0, 'The node returned an unexpected response');
  }

  const record = payload as Record<string, unknown>;
  if (!Array.isArray(record.admins)) {
    throw new PanelApiError(0, 'The node returned an unexpected response');
  }

  const admins = record.admins
    .map(readAdmin)
    .filter((admin): admin is PanelAdmin => admin !== null);

  return {
    admins,
    added: record.added === true,
    removed: record.removed === true,
    inviteSent: record.inviteSent === true,
  };
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function whole(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback;
}

function readRelayReport(value: unknown): RelayReport | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const url = normalizeRelay(record.url);
  if (!url) return null;

  return {
    url,
    connected: record.connected === true,
    anchorCount: whole(record.anchorCount, 0),
    locatorCount: whole(record.locatorCount, 0),
    ...(typeof record.error === 'string' && record.error ? { error: record.error } : {}),
  };
}

function isNostrEvent(value: unknown): value is NostrEvent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;

  return typeof record.id === 'string'
    && typeof record.pubkey === 'string'
    && typeof record.sig === 'string'
    && typeof record.content === 'string'
    && typeof record.created_at === 'number'
    && typeof record.kind === 'number'
    && Array.isArray(record.tags);
}

function readSettings(payload: unknown): PanelSettings {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new PanelApiError(0, 'The node returned an unexpected response');
  }

  const record = payload as Record<string, unknown>;
  if (!Array.isArray(record.relays)) {
    throw new PanelApiError(0, 'The node returned an unexpected response');
  }

  const operator = record.operator && typeof record.operator === 'object' && !Array.isArray(record.operator)
    ? record.operator as Record<string, unknown>
    : {};
  const identity = record.identity && typeof record.identity === 'object' && !Array.isArray(record.identity)
    ? record.identity as Record<string, unknown>
    : {};
  const cadence = record.cadence && typeof record.cadence === 'object' && !Array.isArray(record.cadence)
    ? record.cadence as Record<string, unknown>
    : {};
  const publication = record.publication && typeof record.publication === 'object' && !Array.isArray(record.publication)
    ? record.publication as Record<string, unknown>
    : {};

  const operatorPubkey = typeof operator.pubkey === 'string' && /^[0-9a-f]{64}$/i.test(operator.pubkey)
    ? operator.pubkey.toLowerCase()
    : null;

  return {
    operator: {
      pubkey: operatorPubkey,
      npub: typeof operator.npub === 'string' && operator.npub.startsWith('npub1') ? operator.npub : null,
    },
    relays: record.relays
      .map(normalizeRelay)
      .filter((relay): relay is string => relay !== null),
    identity: {
      name: text(identity.name),
      displayName: text(identity.displayName),
      about: text(identity.about),
      picture: text(identity.picture),
      nip05: text(identity.nip05),
      published: identity.published === true,
    },
    cadence: {
      refreshIntervalMinutes: whole(cadence.refreshIntervalMinutes, 360),
      ncc02ExpiryDays: whole(cadence.ncc02ExpiryDays, 14),
      ncc05TtlHours: whole(cadence.ncc05TtlHours, 12),
    },
    publication: {
      services: whole(publication.services, 0),
      lastPublishedAt: typeof publication.lastPublishedAt === 'number'
        && Number.isFinite(publication.lastPublishedAt)
        ? publication.lastPublishedAt
        : null,
    },
  };
}

async function requestJson(
  base: string,
  signer: PanelSigner,
  method: Nip98Method,
  path: string,
  body: Record<string, unknown> | undefined,
  signal?: AbortSignal,
): Promise<unknown> {
  const authorization = await nip98Authorization(signer, `${base}${path}`, method);

  let response: Response;
  try {
    response = await fetch(`/ncc-api${path}`, {
      method,
      headers: {
        Authorization: authorization,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      cache: 'no-store',
      signal,
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new PanelApiError(0, 'The node admin API is unreachable');
  }

  // A listener without the API falls through to the SPA build, so never parse
  // HTML: report the address problem instead of an unexpected response.
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('json')) {
    throw new PanelApiError(
      response.ok ? 404 : response.status,
      'The node admin API is not served on this address. Open the panel through the admin service.',
    );
  }

  const payload: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    const message = payload && typeof payload === 'object'
      && typeof (payload as { error?: unknown }).error === 'string'
      ? (payload as { error: string }).error
      : `The node admin API returned HTTP ${response.status}`;
    throw new PanelApiError(response.status, message);
  }

  return payload;
}

export async function listPanelAdmins(
  base: string,
  signer: PanelSigner,
  signal?: AbortSignal,
): Promise<PanelAdminResult> {
  return readResult(await requestJson(base, signer, 'GET', '/admins', undefined, signal));
}

export async function addPanelAdmin(
  base: string,
  signer: PanelSigner,
  npub: string,
  signal?: AbortSignal,
): Promise<PanelAdminResult> {
  return readResult(await requestJson(base, signer, 'POST', '/admins', { npub }, signal));
}

export async function removePanelAdmin(
  base: string,
  signer: PanelSigner,
  pubkey: string,
  signal?: AbortSignal,
): Promise<PanelAdminResult> {
  return readResult(await requestJson(base, signer, 'DELETE', `/admins/${pubkey}`, undefined, signal));
}

export async function loadPanelSettings(
  base: string,
  signer: PanelSigner,
  signal?: AbortSignal,
): Promise<PanelSettings> {
  return readSettings(await requestJson(base, signer, 'GET', '/settings', undefined, signal));
}

/**
 * Published NCC records, queried by the sidecar.
 *
 * NCC Browser pages cannot open WebSockets to public relays, so the browser
 * would always report every relay unreachable there. The sidecar has normal
 * network access and already knows the publication relays.
 */
export async function loadPanelRecords(
  base: string,
  signer: PanelSigner,
  signal?: AbortSignal,
): Promise<PanelSnapshot> {
  const payload = await requestJson(base, signer, 'GET', '/records', undefined, signal);

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new PanelApiError(0, 'The node returned an unexpected response');
  }

  const record = payload as Record<string, unknown>;
  if (!Array.isArray(record.relays) || !Array.isArray(record.events)) {
    throw new PanelApiError(0, 'The node returned an unexpected response');
  }

  const relays = record.relays
    .map(readRelayReport)
    .filter((report): report is RelayReport => report !== null);
  const events = record.events.filter(isNostrEvent);

  return buildPanelSnapshot(events, relays);
}

export async function savePanelRelays(
  base: string,
  signer: PanelSigner,
  relays: string[],
  signal?: AbortSignal,
): Promise<PanelSettings> {
  return readSettings(await requestJson(base, signer, 'PUT', '/settings/relays', { relays }, signal));
}

export async function savePanelIdentity(
  base: string,
  signer: PanelSigner,
  identity: Omit<PanelIdentity, 'name'>,
  signal?: AbortSignal,
): Promise<PanelSettings> {
  return readSettings(await requestJson(base, signer, 'PUT', '/settings/identity', { ...identity }, signal));
}

export async function savePanelCadence(
  base: string,
  signer: PanelSigner,
  cadence: PanelCadence,
  signal?: AbortSignal,
): Promise<PanelSettings> {
  return readSettings(await requestJson(base, signer, 'PUT', '/settings/cadence', { ...cadence }, signal));
}
