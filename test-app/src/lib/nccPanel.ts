/**
 * Read-only data for the admin panel.
 *
 * The panel reads the operator identity from /ncc-config.json (served by
 * Caddy from NCC_OPERATOR_PUBKEY) or from the ncc:// address itself, then
 * queries the public NCC records that node publishes (kind 30059 anchors and
 * kind 30058 locators). Nothing here writes, and nothing trusts an
 * unverified record: every query is constrained to the operator pubkey.
 */

import { SimplePool, nip19, type NostrEvent } from 'nostr-tools';

import { npubFromConfigRecord, npubFromLocation } from './nccAddress';

export const FALLBACK_RELAYS = [
  'wss://relay.primal.net/',
  'wss://relay.ditto.pub/',
  'wss://nos.lol/',
];

const CONFIG_PATH = '/ncc-config.json';
const CONNECT_TIMEOUT_MS = 6000;
const QUERY_TIMEOUT_MS = 8000;

export type ServiceStatus = 'published' | 'expired' | 'anchor-only' | 'locator-only';

export interface PanelConfig {
  npub: string | null;
  relays: string[];
  /** Absolute base for signed admin API calls, published by the node. */
  panelApi: string | null;
}

export interface RelayReport {
  url: string;
  connected: boolean;
  anchorCount: number;
  locatorCount: number;
  error?: string;
}

export interface PanelService {
  id: string;
  endpoint: string | null;
  pin: string | null;
  anchorCreatedAt: number | null;
  anchorExpiresAt: number | null;
  locatorCreatedAt: number | null;
  locatorUpdatedAt: number | null;
  expiresAt: number | null;
  ttlSeconds: number | null;
  status: ServiceStatus;
}

export interface PanelActivity {
  serviceId: string;
  kind: 30059 | 30058;
  createdAt: number;
}

export interface PanelSnapshot {
  services: PanelService[];
  activity: PanelActivity[];
  relays: RelayReport[];
  latestPublishedAt: number | null;
}

/** Normalise a relay URL and reject anything that is not ws(s). */
export function normalizeRelay(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!/^wss?:\/\//i.test(trimmed)) return null;

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'wss:' && parsed.protocol !== 'ws:') return null;
    const path = parsed.pathname === '/' ? '/' : `${parsed.pathname.replace(/\/+$/, '')}/`;
    return `${parsed.protocol}//${parsed.host}${path}`;
  } catch {
    return null;
  }
}

/** Decode a published npub into the hex pubkey relays filter on. */
export function operatorPubkeyFromNpub(npub: string | null | undefined): string | null {
  if (!npub) return null;

  try {
    const decoded = nip19.decode(npub);
    return decoded.type === 'npub' ? decoded.data.toLowerCase() : null;
  } catch {
    return null;
  }
}

export async function loadPanelConfig(signal?: AbortSignal): Promise<PanelConfig> {
  let npub: string | null = null;
  let relays: string[] = [];
  let panelApi: string | null = null;

  try {
    const response = await fetch(CONFIG_PATH, { cache: 'no-store', signal });
    if (response.ok) {
      // A missing config file falls through to index.html on the SPA
      // listeners. Only parse a real JSON response, so the HTML fallback is
      // treated exactly like an absent file instead of throwing.
      const contentType = response.headers.get('content-type') ?? '';
      if (contentType.includes('json')) {
        const payload: unknown = await response.json();
        if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
          const record = payload as Record<string, unknown>;
          npub = npubFromConfigRecord(record);

          if (typeof record.panelApi === 'string') panelApi = record.panelApi;

          if (Array.isArray(record.relays)) {
            relays = record.relays
              .map(normalizeRelay)
              .filter((relay): relay is string => relay !== null);
          }
        }
      }
    }
  } catch {
    // Missing config is a normal first-run state, and an abort is handled by
    // the caller. Fall through to the default relay set either way.
  }

  // Under ncc:// the address itself names the operator, so a missing or
  // wiped ncc-config.json never leaves the panel without an identity.
  npub ??= npubFromLocation();

  return {
    npub,
    relays: relays.length ? Array.from(new Set(relays)) : FALLBACK_RELAYS,
    panelApi,
  };
}

/** Copy text without assuming a secure context (ncc:// is not one). */
export async function copyText(value: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    // Fall through to the legacy path.
  }

  try {
    const area = document.createElement('textarea');
    area.value = value;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.top = '-1000px';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const copied = document.execCommand('copy');
    document.body.removeChild(area);
    return copied;
  } catch {
    return false;
  }
}

function tagValue(event: NostrEvent, name: string): string | null {
  const tag = event.tags.find((entry) => entry[0] === name);
  return tag?.[1] ?? null;
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function parseObject(value: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

interface LocatorDetails {
  endpoints: { url: string; k: string | null }[];
  ttl: number | null;
  updatedAt: number | null;
  expiresAt: number | null;
}

function readLocator(event: NostrEvent): LocatorDetails {
  const content = parseObject(event.content);
  const endpoints: { url: string; k: string | null }[] = [];

  if (content && Array.isArray(content.endpoints)) {
    for (const entry of content.endpoints) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
      const record = entry as Record<string, unknown>;
      const url = stringValue(record.url);
      if (url) endpoints.push({ url, k: stringValue(record.k) });
    }
  }

  const expiration = tagValue(event, 'expiration');

  return {
    endpoints,
    ttl: content ? numberValue(content.ttl) : null,
    updatedAt: content ? numberValue(content.updated_at) : null,
    expiresAt: expiration && /^\d+$/.test(expiration) ? Number(expiration) : null,
  };
}

function locatorServiceId(dTag: string): string {
  return dTag.endsWith('-locator') ? dTag.slice(0, -'-locator'.length) : dTag;
}

export async function loadPanelSnapshot(
  pubkey: string,
  relays: string[],
  signal?: AbortSignal,
): Promise<PanelSnapshot> {
  const pool = new SimplePool();
  const filter = { kinds: [30059, 30058], authors: [pubkey], limit: 200 };
  const reports: RelayReport[] = [];
  const anchors = new Map<string, NostrEvent>();
  const locators = new Map<string, NostrEvent>();

  const abort = () => pool.close(relays);
  signal?.addEventListener('abort', abort, { once: true });

  try {
    await Promise.all(
      relays.map(async (url) => {
        const report: RelayReport = { url, connected: false, anchorCount: 0, locatorCount: 0 };

        try {
          const relay = await pool.ensureRelay(url, { connectionTimeout: CONNECT_TIMEOUT_MS });
          report.connected = relay.connected;

          const events = await pool.querySync([url], filter, { maxWait: QUERY_TIMEOUT_MS });
          for (const event of events) {
            const dTag = tagValue(event, 'd');
            if (!dTag) continue;

            if (event.kind === 30059) {
              report.anchorCount += 1;
              const existing = anchors.get(dTag);
              if (!existing || existing.created_at < event.created_at) anchors.set(dTag, event);
            } else if (event.kind === 30058) {
              report.locatorCount += 1;
              const existing = locators.get(dTag);
              if (!existing || existing.created_at < event.created_at) locators.set(dTag, event);
            }
          }
        } catch (error) {
          report.connected = false;
          report.error = error instanceof Error ? error.message : 'connection failed';
        } finally {
          reports.push(report);
        }
      }),
    );
  } finally {
    signal?.removeEventListener('abort', abort);
    pool.close(relays);
  }

  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

  const now = Math.floor(Date.now() / 1000);
  const ids = new Set<string>(anchors.keys());
  for (const dTag of locators.keys()) ids.add(locatorServiceId(dTag));

  const services: PanelService[] = [];
  for (const id of ids) {
    const anchor = anchors.get(id) ?? null;
    const locator = locators.get(`${id}-locator`) ?? locators.get(id) ?? null;
    const details = locator ? readLocator(locator) : null;
    const anchorEndpoint = anchor ? tagValue(anchor, 'u') : null;
    const anchorExpiration = anchor ? tagValue(anchor, 'exp') : null;

    const endpoint = anchorEndpoint ?? details?.endpoints[0]?.url ?? null;
    const pin = (anchor ? tagValue(anchor, 'k') : null) ?? details?.endpoints[0]?.k ?? null;

    let status: ServiceStatus;
    if (!anchor) {
      status = 'locator-only';
    } else if (!locator) {
      status = 'anchor-only';
    } else if (details && details.expiresAt !== null && details.expiresAt <= now) {
      status = 'expired';
    } else {
      status = 'published';
    }

    services.push({
      id,
      endpoint,
      pin,
      anchorCreatedAt: anchor?.created_at ?? null,
      anchorExpiresAt: anchorExpiration && /^\d+$/.test(anchorExpiration) ? Number(anchorExpiration) : null,
      locatorCreatedAt: locator?.created_at ?? null,
      locatorUpdatedAt: details?.updatedAt ?? null,
      expiresAt: details?.expiresAt ?? null,
      ttlSeconds: details?.ttl ?? null,
      status,
    });
  }

  services.sort((a, b) => a.id.localeCompare(b.id));

  const activity: PanelActivity[] = [
    ...Array.from(anchors.entries()).map(([dTag, event]): PanelActivity => ({
      serviceId: dTag,
      kind: 30059,
      createdAt: event.created_at,
    })),
    ...Array.from(locators.entries()).map(([dTag, event]): PanelActivity => ({
      serviceId: locatorServiceId(dTag),
      kind: 30058,
      createdAt: event.created_at,
    })),
  ].sort((a, b) => b.createdAt - a.createdAt);

  return {
    services,
    activity,
    relays: reports.sort((a, b) => a.url.localeCompare(b.url)),
    latestPublishedAt: activity[0]?.createdAt ?? null,
  };
}

/** Accept a bech32 npub or a hex pubkey from the admin form. */
export function pubkeyFromAdminInput(value: string): string | null {
  const trimmed = value.trim();
  if (/^[0-9a-f]{64}$/i.test(trimmed)) return trimmed.toLowerCase();
  return operatorPubkeyFromNpub(trimmed.toLowerCase());
}
