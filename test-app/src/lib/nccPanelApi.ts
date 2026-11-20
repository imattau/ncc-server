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
 * handler. The signed URL still has to be absolute, so it comes from the
 * `panelApi` field the node serves in /ncc-config.json. NCC Browser's mobile
 * pages run on an internal `http://<npub>.admin.localhost:<random>` origin,
 * which is not the address the node sees.
 */

import { nip98Authorization, type Nip98Method, type PanelSigner } from './nip98';
import {
  buildPanelSnapshot,
  normalizeRelay,
  type PanelSnapshot,
  type RelayReport,
} from './nccPanel';
import type { NostrEvent } from 'nostr-tools';

export type PanelNpanelRole = 'admin' | 'staff';

/**
 * The node's admin list is separate from npanel's own users table. The
 * sidecar mirrors changes into npanel and reports how that went, so a
 * partial success can be shown instead of silently diverging.
 */
export interface PanelNpanelStatus {
  configured: boolean;
  available?: boolean;
  synced?: boolean;
  role?: PanelNpanelRole | null;
  error: string | null;
}

export interface PanelAdmin {
  pubkey: string;
  npub: string;
  status: string;
  createdAt: string | null;
  /** Omitted when npanel could not be read, so "no access" is never guessed. */
  npanelRole?: PanelNpanelRole | null;
}

export interface PanelAdminResult {
  admins: PanelAdmin[];
  added?: boolean;
  removed?: boolean;
  inviteSent?: boolean;
  npanel?: PanelNpanelStatus;
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
 * The node publishes this base in /ncc-config.json, and the sidecar accepts
 * it as its canonical public origin. Prefer it whenever it is present: NCC
 * Browser serves ncc:// pages from an internal
 * `http://<npub>.admin.localhost:<random>` origin, which is neither the
 * address the node sees nor stable across launches. A page served directly
 * over http(s) falls back to its own origin only when no base was published.
 */
export function resolvePanelApiBase(panelApi: string | null | undefined): string | null {
  const published = httpBase(panelApi);
  if (published) return published;

  if (typeof window !== 'undefined') {
    const { protocol, origin } = window.location;
    if (protocol === 'http:' || protocol === 'https:') return `${origin}/ncc-api`;
  }

  return null;
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

  const npanelRole = record.npanelRole === 'admin' || record.npanelRole === 'staff'
    ? record.npanelRole
    : record.npanelRole === null ? null : undefined;

  return {
    pubkey: record.pubkey.toLowerCase(),
    npub: record.npub,
    status: typeof record.status === 'string' ? record.status : 'active',
    createdAt: typeof record.createdAt === 'string' ? record.createdAt : null,
    ...(npanelRole === undefined ? {} : { npanelRole }),
  };
}

function readNpanelStatus(value: unknown): PanelNpanelStatus | undefined {
  const record = objectValue(value);
  if (!record) return undefined;

  return {
    configured: record.configured === true,
    available: typeof record.available === 'boolean' ? record.available : undefined,
    synced: typeof record.synced === 'boolean' ? record.synced : undefined,
    role: record.role === 'admin' || record.role === 'staff' ? record.role : null,
    error: stringOrNull(record.error),
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
  const npanel = readNpanelStatus(record.npanel);

  return {
    admins,
    added: record.added === true,
    removed: record.removed === true,
    inviteSent: record.inviteSent === true,
    ...(npanel ? { npanel } : {}),
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
    if (error instanceof DOMException && error.name === 'TimeoutError') {
      throw new PanelApiError(0, 'The node admin API took too long to respond');
    }
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

export type ServiceHealthState = 'healthy' | 'degraded' | 'unreachable' | 'unknown';

export interface PanelServiceProbe {
  url: string | null;
  ok: boolean | null;
  status: number | null;
  latencyMs: number | null;
  error: string | null;
}

export interface PanelServiceContainer {
  state: string;
  health: string | null;
  restartCount: number;
  names: string[];
}

export interface PanelServiceRelayResult {
  url: string;
  success: boolean;
  error?: string;
  timestamp?: number;
}

export interface PanelServicePublication {
  lastPublishedAt: number | null;
  intervalMinutes: number | null;
  onionAddress: string | null;
  ncc02Id: string | null;
  ncc05Id: string | null;
  relays: PanelServiceRelayResult[];
}

export interface PanelServiceStatus {
  serviceId: string;
  name: string;
  recordId: number;
  status: string;
  composeServices: string[];
  probe: PanelServiceProbe;
  container: PanelServiceContainer | null;
  publication: PanelServicePublication;
  package: {
    publisher: string | null;
    npub: string | null;
    version: string | null;
    verified: boolean;
  } | null;
  restartable: boolean;
  health: ServiceHealthState;
}

export interface PanelServiceHealth {
  agent: { available: boolean; error: string | null };
  services: PanelServiceStatus[];
}

export interface PanelNodeLog {
  level: string;
  message: string;
  timestamp: string | null;
  metadata: Record<string, unknown> | null;
}

export interface PanelContainerLog {
  service: string;
  container: string;
  stream: string;
  timestamp: string | null;
  message: string;
}

export interface PanelServiceLogs {
  serviceId: string;
  node: PanelNodeLog[];
  container: { available: boolean; error: string | null; logs: PanelContainerLog[] };
}

export interface PanelRestartResult {
  serviceId: string;
  accepted: boolean;
  containers: { service: string; name: string; state: string }[];
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readProbe(value: unknown): PanelServiceProbe {
  const record = objectValue(value) ?? {};
  return {
    url: stringOrNull(record.url),
    ok: typeof record.ok === 'boolean' ? record.ok : null,
    status: numberOrNull(record.status),
    latencyMs: numberOrNull(record.latencyMs),
    error: stringOrNull(record.error),
  };
}

function readContainer(value: unknown): PanelServiceContainer | null {
  const record = objectValue(value);
  if (!record) return null;

  return {
    state: typeof record.state === 'string' ? record.state : 'unknown',
    health: stringOrNull(record.health),
    restartCount: numberOrNull(record.restartCount) ?? 0,
    names: Array.isArray(record.names)
      ? record.names.filter((name): name is string => typeof name === 'string')
      : [],
  };
}

function readPublication(value: unknown): PanelServicePublication {
  const record = objectValue(value) ?? {};
  const relays = Array.isArray(record.relays) ? record.relays : [];

  return {
    lastPublishedAt: numberOrNull(record.lastPublishedAt),
    intervalMinutes: numberOrNull(record.intervalMinutes),
    onionAddress: stringOrNull(record.onionAddress),
    ncc02Id: stringOrNull(record.ncc02Id),
    ncc05Id: stringOrNull(record.ncc05Id),
    relays: relays.flatMap((entry): PanelServiceRelayResult[] => {
      const relay = objectValue(entry);
      const url = relay ? normalizeRelay(relay.url) : null;
      if (!relay || !url) return [];
      return [{
        url,
        success: relay.success === true,
        ...(stringOrNull(relay.error) ? { error: stringOrNull(relay.error) as string } : {}),
        ...(numberOrNull(relay.timestamp) !== null ? { timestamp: numberOrNull(relay.timestamp) as number } : {}),
      }];
    }),
  };
}

function readPackageProvenance(value: unknown): PanelServiceStatus['package'] {
  const record = objectValue(value);
  if (!record) return null;
  return {
    publisher: stringOrNull(record.publisher),
    npub: stringOrNull(record.npub),
    version: stringOrNull(record.version),
    verified: record.verified === true,
  };
}

function readServiceStatus(value: unknown): PanelServiceStatus | null {
  const record = objectValue(value);
  if (!record || typeof record.serviceId !== 'string' || !record.serviceId) return null;

  const health = record.health;
  return {
    serviceId: record.serviceId,
    name: typeof record.name === 'string' ? record.name : record.serviceId,
    recordId: numberOrNull(record.recordId) ?? 0,
    status: typeof record.status === 'string' ? record.status : 'active',
    composeServices: Array.isArray(record.composeServices)
      ? record.composeServices.filter((name): name is string => typeof name === 'string')
      : [],
    probe: readProbe(record.probe),
    container: readContainer(record.container),
    publication: readPublication(record.publication),
    package: readPackageProvenance(record.package),
    restartable: record.restartable === true,
    health: health === 'healthy' || health === 'degraded'
      || health === 'unreachable' || health === 'unknown'
      ? health
      : 'unknown',
  };
}

function readServiceHealth(payload: unknown): PanelServiceHealth {
  const record = objectValue(payload);
  if (!record || !Array.isArray(record.services)) {
    throw new PanelApiError(0, 'The node returned an unexpected services response');
  }

  const agent = objectValue(record.agent) ?? {};
  return {
    agent: {
      available: agent.available === true,
      error: stringOrNull(agent.error),
    },
    services: record.services
      .map(readServiceStatus)
      .filter((status): status is PanelServiceStatus => status !== null),
  };
}

function readServiceLogs(payload: unknown): PanelServiceLogs {
  const record = objectValue(payload);
  if (!record || typeof record.serviceId !== 'string' || !Array.isArray(record.node)) {
    throw new PanelApiError(0, 'The node returned an unexpected logs response');
  }

  const container = objectValue(record.container) ?? {};
  const logs = Array.isArray(container.logs) ? container.logs : [];

  return {
    serviceId: record.serviceId,
    node: record.node.flatMap((entry): PanelNodeLog[] => {
      const log = objectValue(entry);
      if (!log || typeof log.message !== 'string') return [];
      return [{
        level: typeof log.level === 'string' ? log.level : 'info',
        message: log.message,
        timestamp: stringOrNull(log.timestamp),
        metadata: objectValue(log.metadata),
      }];
    }),
    container: {
      available: container.available === true,
      error: stringOrNull(container.error),
      logs: logs.flatMap((entry): PanelContainerLog[] => {
        const log = objectValue(entry);
        if (!log || typeof log.message !== 'string') return [];
        return [{
          service: typeof log.service === 'string' ? log.service : '',
          container: typeof log.container === 'string' ? log.container : '',
          stream: typeof log.stream === 'string' ? log.stream : 'stdout',
          timestamp: stringOrNull(log.timestamp),
          message: log.message,
        }];
      }),
    },
  };
}

/** Health, probe and container state for every configured service. */
export async function loadPanelServices(
  base: string,
  signer: PanelSigner,
  signal?: AbortSignal,
): Promise<PanelServiceHealth> {
  return readServiceHealth(await requestJson(base, signer, 'GET', '/services', undefined, signal));
}

/** Node events and recent container output for one service. */
export async function loadPanelServiceLogs(
  base: string,
  signer: PanelSigner,
  serviceId: string,
  signal?: AbortSignal,
): Promise<PanelServiceLogs> {
  const path = `/services/${encodeURIComponent(serviceId)}/logs?limit=200`;
  return readServiceLogs(await requestJson(base, signer, 'GET', path, undefined, signal));
}

/** Force one service through a publish cycle. */
export async function republishPanelService(
  base: string,
  signer: PanelSigner,
  serviceId: string,
  signal?: AbortSignal,
): Promise<{ serviceId: string; publishedAt: number }> {
  const payload = await requestJson(
    base, signer, 'POST',
    `/services/${encodeURIComponent(serviceId)}/republish`,
    undefined,
    signal,
  );
  const record = objectValue(payload);
  if (!record || record.success !== true || typeof record.serviceId !== 'string') {
    throw new PanelApiError(0, 'The node did not confirm the republish');
  }

  return {
    serviceId: record.serviceId,
    publishedAt: numberOrNull(record.publishedAt) ?? Date.now(),
  };
}

/** Restart the Compose container(s) that back one service. */
export async function restartPanelService(
  base: string,
  signer: PanelSigner,
  serviceId: string,
  signal?: AbortSignal,
): Promise<PanelRestartResult> {
  const payload = await requestJson(
    base, signer, 'POST',
    `/services/${encodeURIComponent(serviceId)}/restart`,
    undefined,
    signal,
  );
  const record = objectValue(payload);
  if (!record || record.success !== true || typeof record.serviceId !== 'string') {
    throw new PanelApiError(0, 'The node did not confirm the restart');
  }

  const containers = Array.isArray(record.containers)
    ? record.containers.flatMap((entry) => {
        const container = objectValue(entry);
        if (!container || typeof container.name !== 'string') return [];
        return [{
          service: typeof container.service === 'string' ? container.service : '',
          name: container.name,
          state: typeof container.state === 'string' ? container.state : 'unknown',
        }];
      })
    : [];

  return {
    serviceId: record.serviceId,
    accepted: record.accepted === true,
    containers,
  };
}

// --- node images -----------------------------------------------------------

export interface PanelNodeImageContainer {
  name: string;
  state: string;
  health: string | null;
}

export interface PanelNodeImageUpdate {
  state: string;
  changed: boolean;
  imageId: string | null;
  error: string | null;
}

export interface PanelNodeImage {
  service: string;
  label: string;
  description: string;
  role: 'core' | 'infrastructure';
  image: string | null;
  tag: string | null;
  imageId: string | null;
  imageCreatedAt: string | null;
  state: string;
  health: string | null;
  containers: PanelNodeImageContainer[];
  updatable: boolean;
  remoteDigest: string | null;
  updateAvailable: boolean | null;
  checkError: string | null;
  checkedAt: string | null;
  update: PanelNodeImageUpdate | null;
}

export interface PanelNodeImages {
  agent: { available: boolean; error: string | null };
  updating: boolean;
  startedAt: number | null;
  finishedAt: number | null;
  error: string | null;
  images: PanelNodeImage[];
}

function readNodeImage(value: unknown): PanelNodeImage | null {
  const record = objectValue(value);
  if (!record || typeof record.service !== 'string' || !record.service) return null;

  const containers = Array.isArray(record.containers) ? record.containers : [];
  const update = objectValue(record.update);

  return {
    service: record.service,
    label: typeof record.label === 'string' ? record.label : record.service,
    description: typeof record.description === 'string' ? record.description : '',
    role: record.role === 'infrastructure' ? 'infrastructure' : 'core',
    image: stringOrNull(record.image),
    tag: stringOrNull(record.tag),
    imageId: stringOrNull(record.imageId),
    imageCreatedAt: stringOrNull(record.imageCreatedAt),
    state: typeof record.state === 'string' ? record.state : 'unknown',
    health: stringOrNull(record.health),
    containers: containers.flatMap((entry): PanelNodeImageContainer[] => {
      const container = objectValue(entry);
      if (!container) return [];
      return [{
        name: typeof container.name === 'string' ? container.name : '',
        state: typeof container.state === 'string' ? container.state : 'unknown',
        health: stringOrNull(container.health),
      }];
    }),
    updatable: record.updatable === true,
    remoteDigest: stringOrNull(record.remoteDigest),
    updateAvailable: typeof record.updateAvailable === 'boolean' ? record.updateAvailable : null,
    checkError: stringOrNull(record.checkError),
    checkedAt: stringOrNull(record.checkedAt),
    update: update ? {
      state: typeof update.state === 'string' ? update.state : 'unknown',
      changed: update.changed === true,
      imageId: stringOrNull(update.imageId),
      error: stringOrNull(update.error),
    } : null,
  };
}

export function readNodeImages(payload: unknown): PanelNodeImages {
  const record = objectValue(payload);
  if (!record || !Array.isArray(record.images)) {
    throw new PanelApiError(0, 'The node returned an unexpected image list');
  }

  const agent = objectValue(record.agent) ?? {};
  return {
    agent: {
      available: agent.available === true,
      error: stringOrNull(agent.error),
    },
    updating: record.updating === true,
    startedAt: numberOrNull(record.startedAt),
    finishedAt: numberOrNull(record.finishedAt),
    error: stringOrNull(record.error),
    images: record.images
      .map(readNodeImage)
      .filter((image): image is PanelNodeImage => image !== null),
  };
}

/** The bundle's own images with their current tag and last update result. */
export async function loadPanelImages(
  base: string,
  signer: PanelSigner,
  signal?: AbortSignal,
  refresh = false,
): Promise<PanelNodeImages> {
  return readNodeImages(await requestJson(
    base,
    signer,
    'GET',
    `/images${refresh ? '?refresh=1' : ''}`,
    undefined,
    signal,
  ));
}

export interface PanelImageUpdateStart {
  services: string[];
  accepted: boolean;
  progressToken: string | null;
}

/**
 * Start one pull/recreate run for several images. The response carries a
 * short-lived token for reading progress without another NIP-98 signature.
 */
export async function updatePanelImages(
  base: string,
  signer: PanelSigner,
  services: string[],
  signal?: AbortSignal,
): Promise<PanelImageUpdateStart> {
  const payload = await requestJson(
    base,
    signer,
    'POST',
    '/images/update',
    { services },
    signal,
  );
  const record = objectValue(payload);
  if (!record || record.success !== true || !Array.isArray(record.services)) {
    throw new PanelApiError(0, 'The node did not confirm the image update');
  }

  return {
    services: record.services.filter((service): service is string => typeof service === 'string'),
    accepted: record.accepted === true,
    progressToken: stringOrNull(record.progressToken),
  };
}

export interface PanelImageProgressService {
  service: string;
  state: string;
  changed: boolean;
  imageId: string | null;
  error: string | null;
}

export interface PanelImageProgress {
  inProgress: boolean;
  startedAt: number | null;
  finishedAt: number | null;
  error: string | null;
  total: number;
  done: number;
  percent: number;
  services: PanelImageProgressService[];
}

export function readImageProgress(payload: unknown): PanelImageProgress {
  const record = objectValue(payload);
  if (!record) {
    throw new PanelApiError(0, 'The node returned an unexpected update progress response');
  }

  const services = (Array.isArray(record.services) ? record.services : []).flatMap(
    (entry): PanelImageProgressService[] => {
      const service = objectValue(entry);
      if (!service || typeof service.service !== 'string') return [];
      return [{
        service: service.service,
        state: typeof service.state === 'string' ? service.state : 'unknown',
        changed: service.changed === true,
        imageId: stringOrNull(service.imageId),
        error: stringOrNull(service.error),
      }];
    },
  );
  const total = numberOrNull(record.total) ?? services.length;
  const done = numberOrNull(record.done) ?? 0;

  return {
    inProgress: record.inProgress === true,
    startedAt: numberOrNull(record.startedAt),
    finishedAt: numberOrNull(record.finishedAt),
    error: stringOrNull(record.error),
    total,
    done,
    percent: numberOrNull(record.percent) ?? (total ? Math.round((done / total) * 100) : 0),
    services,
  };
}

/** Read update progress with the token returned by updatePanelImages. */
export async function loadPanelImageProgress(
  token: string,
  signal?: AbortSignal,
): Promise<PanelImageProgress> {
  const response = await fetch('/ncc-api/images/progress', {
    headers: { Authorization: `Bearer ${token}` },
    cache: 'no-store',
    signal,
  });
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('json')) {
    throw new PanelApiError(response.status, 'The node admin API is not served on this address');
  }
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message = payload && typeof payload === 'object'
      && typeof (payload as { error?: unknown }).error === 'string'
      ? (payload as { error: string }).error
      : 'Could not read the image update progress';
    throw new PanelApiError(response.status, message);
  }
  return readImageProgress(payload);
}

/**
 * Pull a bundle image's tag and recreate its container when the digest
 * changed. The node accepts the work before the pull; reload the list for
 * the result.
 */
export async function updatePanelImage(
  base: string,
  signer: PanelSigner,
  service: string,
  signal?: AbortSignal,
): Promise<{ service: string; accepted: boolean }> {
  const payload = await requestJson(
    base, signer, 'POST',
    `/images/${encodeURIComponent(service)}/update`,
    undefined,
    signal,
  );
  const record = objectValue(payload);
  if (!record || record.success !== true || typeof record.service !== 'string') {
    throw new PanelApiError(0, 'The node did not confirm the image update');
  }

  return {
    service: record.service,
    accepted: record.accepted === true,
  };
}

export interface PanelPruneImage {
  ref: string | null;
  refs: string[];
  imageId: string | null;
  sizeBytes: number | null;
  createdAt: string | null;
}

export interface PanelPrunePlan {
  keepPrevious: boolean;
  count: number;
  estimateBytes: number | null;
  images: PanelPruneImage[];
  kept: Array<PanelPruneImage & { reason: string }>;
  repositories: string[];
}

export interface PanelPruneResult {
  keepPrevious: boolean;
  removed: PanelPruneImage[];
  failed: Array<{ ref: string; error: string }>;
  freedBytes: number | null;
}

function readPruneImage(value: unknown): PanelPruneImage | null {
  const record = objectValue(value);
  if (!record) return null;
  const refs = Array.isArray(record.refs)
    ? record.refs.filter((ref): ref is string => typeof ref === 'string')
    : [];
  const ref = stringOrNull(record.ref) ?? refs[0] ?? null;
  if (!ref && refs.length === 0) return null;

  return {
    ref,
    refs,
    imageId: stringOrNull(record.imageId),
    sizeBytes: numberOrNull(record.sizeBytes),
    createdAt: stringOrNull(record.createdAt),
  };
}

export function readPanelPrunePlan(payload: unknown): PanelPrunePlan {
  const record = objectValue(payload);
  if (!record) {
    throw new PanelApiError(0, 'The node returned an unexpected image clean-up plan');
  }
  const images = (Array.isArray(record.images) ? record.images : [])
    .map(readPruneImage)
    .filter((image): image is PanelPruneImage => image !== null);
  const kept = (Array.isArray(record.kept) ? record.kept : []).flatMap((entry) => {
    const image = readPruneImage(entry);
    if (!image) return [];
    const source = objectValue(entry);
    return [{
      ...image,
      reason: typeof source?.reason === 'string' ? source.reason : 'kept',
    }];
  });

  return {
    keepPrevious: record.keepPrevious !== false,
    count: numberOrNull(record.count) ?? images.length,
    estimateBytes: numberOrNull(record.estimateBytes),
    images,
    kept,
    repositories: Array.isArray(record.repositories)
      ? record.repositories.filter((repo): repo is string => typeof repo === 'string')
      : [],
  };
}

export function readPanelPruneResult(payload: unknown): PanelPruneResult {
  const record = objectValue(payload);
  if (!record) {
    throw new PanelApiError(0, 'The node returned an unexpected image clean-up result');
  }
  const removed = (Array.isArray(record.removed) ? record.removed : [])
    .map(readPruneImage)
    .filter((image): image is PanelPruneImage => image !== null);
  const failed = (Array.isArray(record.failed) ? record.failed : []).flatMap((entry) => {
    const failure = objectValue(entry);
    if (!failure || typeof failure.ref !== 'string') return [];
    return [{
      ref: failure.ref,
      error: typeof failure.error === 'string' ? failure.error : 'The delete failed',
    }];
  });

  return {
    keepPrevious: record.keepPrevious !== false,
    removed,
    failed,
    freedBytes: numberOrNull(record.freedBytes),
  };
}

/**
 * What a clean-up would remove: images in the bundle's own repositories that
 * no project container uses. `keepPrevious` leaves the newest unused release
 * tag in each repository for a manual rollback.
 */
export async function loadPanelPrunePlan(
  base: string,
  signer: PanelSigner,
  keepPrevious = true,
  signal?: AbortSignal,
): Promise<PanelPrunePlan> {
  return readPanelPrunePlan(await requestJson(
    base,
    signer,
    'GET',
    `/images/prune?previous=${keepPrevious ? '1' : '0'}`,
    undefined,
    signal,
  ));
}

/** Remove the unused image tags the plan listed. */
export async function prunePanelImages(
  base: string,
  signer: PanelSigner,
  keepPrevious = true,
  signal?: AbortSignal,
): Promise<PanelPruneResult> {
  return readPanelPruneResult(await requestJson(
    base,
    signer,
    'POST',
    '/images/prune',
    { keepPrevious },
    signal,
  ));
}

// --- server upgrade --------------------------------------------------------

export interface PanelServerRelease {
  version: string | null;
  tag: string | null;
  commit: string | null;
  source: string | null;
}

export interface PanelServerLatest {
  tag: string;
  version: string | null;
  url: string | null;
  publishedAt: string | null;
}

export interface PanelUpgradeHelper {
  available: boolean;
  installed: boolean;
  installedAt: string | null;
  error: string | null;
}

export interface PanelUpgradeStep {
  id: string;
  label: string;
}

export interface PanelUpgradeJob {
  jobId: string | null;
  state: 'running' | 'success' | 'failed';
  step: string | null;
  stepIndex: number;
  totalSteps: number;
  steps: PanelUpgradeStep[];
  target: string | null;
  from: string | null;
  startedAt: number | null;
  finishedAt: number | null;
  error: string | null;
  warning: string | null;
  logTail: string[];
  pins: { updated: string[]; skipped: string[] };
  dryRun: boolean;
}

export interface PanelServerUpgrade {
  current: PanelServerRelease | null;
  latest: PanelServerLatest | null;
  upgradeAvailable: boolean | null;
  reason: string | null;
  helper: PanelUpgradeHelper;
  job: PanelUpgradeJob | null;
  progressToken: string | null;
  checkedAt: number | null;
  error: string | null;
}

export interface PanelUpgradeStatus {
  helper: PanelUpgradeHelper;
  job: PanelUpgradeJob | null;
}

export interface PanelUpgradeStart {
  target: string;
  jobId: string;
  progressToken: string | null;
  accepted: boolean;
}

const UNAVAILABLE_HELPER: PanelUpgradeHelper = {
  available: false,
  installed: false,
  installedAt: null,
  error: 'The host upgrade helper is not available',
};

export function readUpgradeHelper(value: unknown): PanelUpgradeHelper {
  const record = objectValue(value);
  if (!record) return { ...UNAVAILABLE_HELPER };
  return {
    available: record.available === true,
    installed: record.installed === true,
    installedAt: stringOrNull(record.installedAt),
    error: stringOrNull(record.error),
  };
}

export function readUpgradeJob(value: unknown): PanelUpgradeJob | null {
  const record = objectValue(value);
  if (!record) return null;
  if (record.state !== 'running' && record.state !== 'success' && record.state !== 'failed') {
    return null;
  }

  const steps = (Array.isArray(record.steps) ? record.steps : []).flatMap(
    (entry): PanelUpgradeStep[] => {
      const step = objectValue(entry);
      if (!step || typeof step.id !== 'string' || typeof step.label !== 'string') return [];
      return [{ id: step.id, label: step.label }];
    },
  );
  const pins = objectValue(record.pins) ?? {};
  const logTail = (Array.isArray(record.logTail) ? record.logTail : [])
    .filter((line): line is string => typeof line === 'string')
    .slice(-20);
  const total = numberOrNull(record.totalSteps) ?? steps.length;
  const index = numberOrNull(record.stepIndex) ?? 0;

  return {
    jobId: stringOrNull(record.jobId),
    state: record.state,
    step: stringOrNull(record.step),
    stepIndex: Math.max(0, Math.min(index, total)),
    totalSteps: total,
    steps,
    target: stringOrNull(record.target),
    from: stringOrNull(record.from),
    startedAt: numberOrNull(record.startedAt),
    finishedAt: numberOrNull(record.finishedAt),
    error: stringOrNull(record.error),
    warning: stringOrNull(record.warning),
    logTail,
    pins: {
      updated: stringArray(pins.updated, 32),
      skipped: stringArray(pins.skipped, 32),
    },
    dryRun: record.dryRun === true,
  };
}

export function readServerUpgrade(payload: unknown): PanelServerUpgrade {
  const record = objectValue(payload);
  if (!record) throw new PanelApiError(0, 'The node returned an unexpected upgrade response');

  const currentRecord = objectValue(record.current);
  const latestRecord = objectValue(record.latest);
  return {
    current: currentRecord
      ? {
        version: stringOrNull(currentRecord.version),
        tag: stringOrNull(currentRecord.tag),
        commit: stringOrNull(currentRecord.commit),
        source: stringOrNull(currentRecord.source),
      }
      : null,
    latest: latestRecord && typeof latestRecord.tag === 'string'
      ? {
        tag: latestRecord.tag,
        version: stringOrNull(latestRecord.version),
        url: stringOrNull(latestRecord.url),
        publishedAt: stringOrNull(latestRecord.publishedAt),
      }
      : null,
    upgradeAvailable: typeof record.upgradeAvailable === 'boolean'
      ? record.upgradeAvailable
      : null,
    reason: stringOrNull(record.reason),
    helper: readUpgradeHelper(record.helper),
    job: readUpgradeJob(record.job),
    progressToken: stringOrNull(record.progressToken),
    checkedAt: numberOrNull(record.checkedAt),
    error: stringOrNull(record.error),
  };
}

/** Check the host checkout against the latest GitHub release. */
export async function loadServerUpgrade(
  base: string,
  signer: PanelSigner,
  signal?: AbortSignal,
  refresh = false,
): Promise<PanelServerUpgrade> {
  return readServerUpgrade(await requestJson(
    base,
    signer,
    'GET',
    `/upgrade${refresh ? '?refresh=1' : ''}`,
    undefined,
    signal,
  ));
}

/** Start a full server upgrade for a validated release tag. */
export async function startServerUpgrade(
  base: string,
  signer: PanelSigner,
  target: string,
  signal?: AbortSignal,
): Promise<PanelUpgradeStart> {
  const payload = await requestJson(
    base,
    signer,
    'POST',
    '/upgrade',
    { target },
    signal,
  );
  const record = objectValue(payload);
  if (!record || record.success !== true
    || typeof record.jobId !== 'string'
    || typeof record.target !== 'string') {
    throw new PanelApiError(0, 'The node did not confirm the server upgrade');
  }
  return {
    target: record.target,
    jobId: record.jobId,
    progressToken: stringOrNull(record.progressToken),
    accepted: record.accepted === true,
  };
}

/** Read upgrade progress with the token returned by the start call. */
export async function loadServerUpgradeProgress(
  token: string,
  signal?: AbortSignal,
): Promise<PanelUpgradeStatus> {
  const response = await fetch('/ncc-api/upgrade/status', {
    headers: { Authorization: `Bearer ${token}` },
    cache: 'no-store',
    signal,
  });
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('json')) {
    throw new PanelApiError(response.status, 'The node admin API is not served on this address');
  }
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message = payload && typeof payload === 'object'
      && typeof (payload as { error?: unknown }).error === 'string'
      ? (payload as { error: string }).error
      : 'Could not read the server upgrade progress';
    throw new PanelApiError(response.status, message);
  }
  const record = objectValue(payload) ?? {};
  return {
    helper: readUpgradeHelper(record.helper),
    job: readUpgradeJob(record.job),
  };
}

// --- npack service catalogue ------------------------------------------------

export interface PanelCatalogueIcon {
  url: string;
  sha256: string;
}

export interface PanelCatalogueEntry {
  releaseEventId: string;
  publisher: string;
  npub: string | null;
  name: string;
  version: string;
  kind: string;
  sha256: string | null;
  publishedAt: number | null;
  compatible: boolean;
  official: boolean;
  trusted: boolean;
  summary: string | null;
  description: string | null;
  homepage: string | null;
  license: string | null;
  categories: string[];
  screenshots: string[];
  icon: PanelCatalogueIcon | null;
  releaseNotes: string | null;
  supportUrl: string | null;
  downloadSize: number | null;
  installedSize: number | null;
  releaseDate: string | null;
  details: {
    repo: string | null;
    commit: string | null;
    depends: string[];
    requires: string[];
    postInstall: string[];
  };
}

export interface PanelCatalogueStatus {
  present: boolean;
  ageSeconds: number | null;
  stale: boolean;
  staleAfterSeconds: number | null;
  releases: number | null;
}

export interface PanelCataloguePublisher {
  publisher: string;
  npub: string | null;
  official: boolean;
}

export interface PanelCatalogue {
  available: boolean;
  error: string | null;
  /** The node is still querying relays and will return a newer listing. */
  refreshing: boolean;
  refreshError: string | null;
  official: { publisher: string; npub: string | null } | null;
  trusted: PanelCataloguePublisher[];
  status: PanelCatalogueStatus | null;
  entries: PanelCatalogueEntry[];
}

export interface PanelServiceDescriptor {
  serviceId: string;
  name: string;
  summary: string | null;
  description: string | null;
  image: string;
  publicPort: number | null;
  backendPort: number | null;
  containerPort: number | null;
  probePath: string;
  categories: string[];
  minBundleVersion: string | null;
  volumes: { name: string; path: string }[];
  envKeys: string[];
}

export interface PanelCatalogueService {
  provenance: {
    publisher: string;
    npub: string | null;
    name: string;
    version: string;
    releaseEventId: string;
    artifactEventId: string | null;
    sha256: string;
    os: string | null;
    arch: string | null;
    verified: boolean;
  };
  descriptor: PanelServiceDescriptor;
  readme: string | null;
  artifact: { sha256: string; size: number; url: string; urls: string[] };
  warnings: string[];
}

function stringArray(value: unknown, maximum = 32): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === 'string')
    .slice(0, maximum);
}

function readCatalogueEntry(value: unknown): PanelCatalogueEntry | null {
  const record = objectValue(value);
  if (!record
    || typeof record.releaseEventId !== 'string' || !record.releaseEventId
    || typeof record.publisher !== 'string' || !record.publisher
    || typeof record.name !== 'string' || !record.name
    || typeof record.version !== 'string' || !record.version) {
    return null;
  }

  const icon = objectValue(record.icon);
  const details = objectValue(record.details) ?? {};

  return {
    releaseEventId: record.releaseEventId,
    publisher: record.publisher,
    npub: stringOrNull(record.npub),
    name: record.name,
    version: record.version,
    kind: typeof record.kind === 'string' ? record.kind : 'ncc-service',
    sha256: stringOrNull(record.sha256),
    publishedAt: numberOrNull(record.publishedAt),
    compatible: record.compatible === true,
    official: record.official === true,
    trusted: record.trusted === true,
    summary: stringOrNull(record.summary),
    description: stringOrNull(record.description),
    homepage: stringOrNull(record.homepage),
    license: stringOrNull(record.license),
    categories: stringArray(record.categories, 8),
    screenshots: stringArray(record.screenshots, 6),
    icon: icon && typeof icon.url === 'string' && typeof icon.sha256 === 'string'
      ? { url: icon.url, sha256: icon.sha256 }
      : null,
    releaseNotes: stringOrNull(record.releaseNotes),
    supportUrl: stringOrNull(record.supportUrl),
    downloadSize: numberOrNull(record.downloadSize),
    installedSize: numberOrNull(record.installedSize),
    releaseDate: stringOrNull(record.releaseDate),
    details: {
      repo: stringOrNull(details.repo),
      commit: stringOrNull(details.commit),
      depends: stringArray(details.depends),
      requires: stringArray(details.requires),
      postInstall: stringArray(details.postInstall),
    },
  };
}

function readCataloguePublisher(value: unknown): PanelCataloguePublisher | null {
  const record = objectValue(value);
  if (!record || typeof record.publisher !== 'string') return null;
  return {
    publisher: record.publisher,
    npub: stringOrNull(record.npub),
    official: record.official === true,
  };
}

function readCatalogueStatus(value: unknown): PanelCatalogueStatus | null {
  const record = objectValue(value);
  if (!record) return null;
  return {
    present: record.present === true,
    ageSeconds: numberOrNull(record.ageSeconds),
    stale: record.stale === true,
    staleAfterSeconds: numberOrNull(record.staleAfterSeconds),
    releases: numberOrNull(record.releases),
  };
}

function readCatalogue(payload: unknown): PanelCatalogue {
  const record = objectValue(payload);
  if (!record) {
    throw new PanelApiError(0, 'The node returned an unexpected catalogue response');
  }

  const official = objectValue(record.official);
  const trusted = Array.isArray(record.trusted) ? record.trusted : [];
  const entries = Array.isArray(record.entries) ? record.entries : [];

  return {
    available: record.available === true,
    error: stringOrNull(record.error),
    refreshing: record.refreshing === true,
    refreshError: stringOrNull(record.refreshError),
    official: official && typeof official.publisher === 'string'
      ? { publisher: official.publisher, npub: stringOrNull(official.npub) }
      : null,
    trusted: trusted
      .map(readCataloguePublisher)
      .filter((entry): entry is PanelCataloguePublisher => entry !== null),
    status: readCatalogueStatus(record.status),
    entries: entries
      .map(readCatalogueEntry)
      .filter((entry): entry is PanelCatalogueEntry => entry !== null),
  };
}

function readDescriptor(value: unknown): PanelServiceDescriptor {
  const record = objectValue(value) ?? {};
  const volumes = objectValue(record.volumes) ?? {};
  const env = objectValue(record.env) ?? {};

  return {
    serviceId: typeof record.service_id === 'string' ? record.service_id : '',
    name: typeof record.name === 'string' ? record.name : '',
    summary: stringOrNull(record.summary),
    description: stringOrNull(record.description),
    image: typeof record.image === 'string' ? record.image : '',
    publicPort: numberOrNull(record.public_port),
    backendPort: numberOrNull(record.backend_port),
    containerPort: numberOrNull(record.container_port),
    probePath: typeof record.probe_path === 'string' ? record.probe_path : '/',
    categories: stringArray(record.categories, 8),
    minBundleVersion: stringOrNull(record.min_bundle_version),
    volumes: Object.entries(volumes).flatMap(([name, path]) => (
      typeof path === 'string' ? [{ name, path }] : []
    )),
    envKeys: Object.keys(env).slice(0, 64),
  };
}

function readCatalogueService(payload: unknown): PanelCatalogueService {
  const record = objectValue(payload);
  const provenance = objectValue(record?.provenance);
  const descriptor = objectValue(record?.descriptor);
  if (!record || !provenance || !descriptor) {
    throw new PanelApiError(0, 'The node returned an unexpected service package');
  }

  const artifact = objectValue(record.artifact) ?? {};
  return {
    provenance: {
      publisher: typeof provenance.publisher === 'string' ? provenance.publisher : '',
      npub: stringOrNull(provenance.npub),
      name: typeof provenance.name === 'string' ? provenance.name : '',
      version: typeof provenance.version === 'string' ? provenance.version : '',
      releaseEventId: typeof provenance.releaseEventId === 'string' ? provenance.releaseEventId : '',
      artifactEventId: stringOrNull(provenance.artifactEventId),
      sha256: typeof provenance.sha256 === 'string' ? provenance.sha256 : '',
      os: stringOrNull(provenance.os),
      arch: stringOrNull(provenance.arch),
      verified: provenance.verified === true,
    },
    descriptor: readDescriptor(descriptor),
    readme: stringOrNull(record.readme),
    artifact: {
      sha256: typeof artifact.sha256 === 'string' ? artifact.sha256 : '',
      size: numberOrNull(artifact.size) ?? 0,
      url: typeof artifact.url === 'string' ? artifact.url : '',
      urls: stringArray(artifact.urls, 8),
    },
    warnings: stringArray(record.warnings, 16),
  };
}

const CATALOGUE_REQUEST_TIMEOUT_MS = 25_000;

/** Catalogue entries from the node's npack service. */
export async function loadPanelCatalogue(
  base: string,
  signer: PanelSigner,
  refresh: boolean,
  signal?: AbortSignal,
): Promise<PanelCatalogue> {
  const query = refresh ? '?refresh=1' : '';
  // A refresh is answered from the node's cached listing while npackd queries
  // relays in the background, so this request should stay small. The timeout
  // exists so a wedged node cannot leave the panel's spinner running forever.
  const timeout = AbortSignal.timeout(CATALOGUE_REQUEST_TIMEOUT_MS);
  return readCatalogue(
    await requestJson(
      base,
      signer,
      'GET',
      `/catalogue${query}`,
      undefined,
      signal ? AbortSignal.any([signal, timeout]) : timeout,
    ),
  );
}

/** Verify and unpack one release, for the details dialog and install command. */
export async function loadPanelCatalogueService(
  base: string,
  signer: PanelSigner,
  releaseEventId: string,
  signal?: AbortSignal,
): Promise<PanelCatalogueService> {
  const path = `/catalogue/service?event=${encodeURIComponent(releaseEventId)}`;
  return readCatalogueService(
    await requestJson(base, signer, 'GET', path, undefined, signal),
  );
}

/** Trust or untrust a publisher. The official publisher is always trusted. */
export async function setPanelCatalogueTrust(
  base: string,
  signer: PanelSigner,
  publisher: string,
  trusted: boolean,
  signal?: AbortSignal,
): Promise<PanelCataloguePublisher[]> {
  const payload = objectValue(
    await requestJson(base, signer, 'PUT', '/catalogue/trust', { publisher, trusted }, signal),
  );
  const list = Array.isArray(payload?.trusted) ? payload.trusted : [];
  return list
    .map(readCataloguePublisher)
    .filter((entry): entry is PanelCataloguePublisher => entry !== null);
}

/** Fetch a verified store icon as a blob; the panel turns it into an object URL. */
export async function loadPanelCatalogueIcon(
  base: string,
  signer: PanelSigner,
  releaseEventId: string,
  signal?: AbortSignal,
): Promise<Blob> {
  const path = `/catalogue/icon/${encodeURIComponent(releaseEventId)}`;
  const authorization = await nip98Authorization(signer, `${base}${path}`, 'GET');

  let response: Response;
  try {
    response = await fetch(`/ncc-api${path}`, {
      headers: { Authorization: authorization },
      cache: 'no-store',
      signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'TimeoutError') {
      throw new PanelApiError(0, 'The node admin API took too long to respond');
    }
    if (signal?.aborted) throw error;
    throw new PanelApiError(0, 'The node admin API is unreachable');
  }

  if (!response.ok) {
    throw new PanelApiError(response.status, 'The release icon is unavailable');
  }
  return response.blob();
}

// --- host metrics ---------------------------------------------------------

export interface PanelHostInfo {
  hostname: string | null;
  kernel: string | null;
  os: string | null;
  dockerVersion: string | null;
  uptimeSeconds: number | null;
}

export interface PanelCpuMetrics {
  cores: number | null;
  load1: number | null;
  load5: number | null;
  load15: number | null;
  usagePercent: number | null;
}

export interface PanelMemoryMetrics {
  totalBytes: number | null;
  availableBytes: number | null;
  usedBytes: number | null;
  usedPercent: number | null;
}

export interface PanelStorageMetrics {
  totalBytes: number | null;
  freeBytes: number | null;
  usedBytes: number | null;
  usedPercent: number | null;
}

export interface PanelDockerUsage {
  imagesBytes: number | null;
  containersBytes: number | null;
  volumesBytes: number | null;
  buildCacheBytes: number | null;
  totalBytes: number | null;
  images: number | null;
  containers: number | null;
  volumes: number | null;
}

export interface PanelMetrics {
  available: boolean;
  error: string | null;
  collectedAt: number | null;
  host: PanelHostInfo;
  cpu: PanelCpuMetrics | null;
  memory: PanelMemoryMetrics | null;
  storage: PanelStorageMetrics | null;
  docker: PanelDockerUsage | null;
}

const METRICS_REQUEST_TIMEOUT_MS = 10_000;

function nonNegativeOrNull(value: unknown): number | null {
  const number = numberOrNull(value);
  return number !== null && number >= 0 ? number : null;
}

function percentOrNull(value: unknown): number | null {
  const number = numberOrNull(value);
  return number !== null && number >= 0 && number <= 100 ? number : null;
}

function readHostInfo(value: unknown): PanelHostInfo {
  const record = objectValue(value) ?? {};
  return {
    hostname: stringOrNull(record.hostname),
    kernel: stringOrNull(record.kernel),
    os: stringOrNull(record.os),
    dockerVersion: stringOrNull(record.dockerVersion),
    uptimeSeconds: nonNegativeOrNull(record.uptimeSeconds),
  };
}

function readCpuMetrics(value: unknown): PanelCpuMetrics | null {
  const record = objectValue(value);
  if (!record) return null;
  const cores = numberOrNull(record.cores);
  return {
    cores: cores !== null && cores >= 1 ? cores : null,
    load1: nonNegativeOrNull(record.load1),
    load5: nonNegativeOrNull(record.load5),
    load15: nonNegativeOrNull(record.load15),
    usagePercent: percentOrNull(record.usagePercent),
  };
}

function readMemoryMetrics(value: unknown): PanelMemoryMetrics | null {
  const record = objectValue(value);
  if (!record) return null;
  return {
    totalBytes: nonNegativeOrNull(record.totalBytes),
    availableBytes: nonNegativeOrNull(record.availableBytes),
    usedBytes: nonNegativeOrNull(record.usedBytes),
    usedPercent: percentOrNull(record.usedPercent),
  };
}

function readStorageMetrics(value: unknown): PanelStorageMetrics | null {
  const record = objectValue(value);
  if (!record) return null;
  return {
    totalBytes: nonNegativeOrNull(record.totalBytes),
    freeBytes: nonNegativeOrNull(record.freeBytes),
    usedBytes: nonNegativeOrNull(record.usedBytes),
    usedPercent: percentOrNull(record.usedPercent),
  };
}

function readDockerUsage(value: unknown): PanelDockerUsage | null {
  const record = objectValue(value);
  if (!record) return null;
  return {
    imagesBytes: nonNegativeOrNull(record.imagesBytes),
    containersBytes: nonNegativeOrNull(record.containersBytes),
    volumesBytes: nonNegativeOrNull(record.volumesBytes),
    buildCacheBytes: nonNegativeOrNull(record.buildCacheBytes),
    totalBytes: nonNegativeOrNull(record.totalBytes),
    images: nonNegativeOrNull(record.images),
    containers: nonNegativeOrNull(record.containers),
    volumes: nonNegativeOrNull(record.volumes),
  };
}

function readMetrics(payload: unknown): PanelMetrics {
  const record = objectValue(payload);
  if (!record) {
    throw new PanelApiError(0, 'The node returned an unexpected metrics response');
  }
  const metrics = objectValue(record.metrics);

  return {
    available: record.available === true,
    error: stringOrNull(record.error),
    collectedAt: metrics ? nonNegativeOrNull(metrics.collectedAt) : null,
    host: readHostInfo(metrics?.host),
    cpu: metrics ? readCpuMetrics(metrics.cpu) : null,
    memory: metrics ? readMemoryMetrics(metrics.memory) : null,
    storage: metrics ? readStorageMetrics(metrics.storage) : null,
    docker: metrics ? readDockerUsage(metrics.docker) : null,
  };
}

/**
 * Host CPU, memory and disk from the node agent. A node without the agent
 * answers with `available: false` rather than an error, so the panel can keep
 * the rest of the page working and say the values are unavailable.
 */
export async function loadPanelMetrics(
  base: string,
  signer: PanelSigner,
  signal?: AbortSignal,
): Promise<PanelMetrics> {
  // The agent samples CPU for a moment and may ask Docker for its disk usage;
  // this bound keeps a wedged agent from holding the sidebar open.
  const timeout = AbortSignal.timeout(METRICS_REQUEST_TIMEOUT_MS);
  return readMetrics(
    await requestJson(
      base,
      signer,
      'GET',
      '/metrics',
      undefined,
      signal ? AbortSignal.any([signal, timeout]) : timeout,
    ),
  );
}

// Exported for the parser tests; the public API above is the supported surface.
export { readCatalogue, readCatalogueEntry, readCatalogueService, readMetrics, readResult };
