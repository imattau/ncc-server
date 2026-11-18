/**
 * Client for the node's admin API.
 *
 * The sidecar keeps the admin list and is the only component that can change
 * it. Caddy publishes it at /ncc-api/* on the admin listener, and every call is
 * signed with NIP-98 by the connected key (see nip98.ts).
 *
 * Requests are relative so NCC Browser maps them to the admin service origin
 * (`ncc://<npub>.admin`); an absolute https URL would bypass the protocol
 * handler. The signed URL still has to be absolute, so an ncc:// page takes it
 * from the `panelApi` field the node serves in /ncc-config.json.
 */

import { nip98Authorization, type Nip98Method, type PanelSigner } from './nip98';

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

async function call(
  base: string,
  signer: PanelSigner,
  method: Nip98Method,
  path: string,
  body: Record<string, unknown> | undefined,
  signal?: AbortSignal,
): Promise<PanelAdminResult> {
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

  return readResult(payload);
}

export function listPanelAdmins(
  base: string,
  signer: PanelSigner,
  signal?: AbortSignal,
): Promise<PanelAdminResult> {
  return call(base, signer, 'GET', '/admins', undefined, signal);
}

export function addPanelAdmin(
  base: string,
  signer: PanelSigner,
  npub: string,
  signal?: AbortSignal,
): Promise<PanelAdminResult> {
  return call(base, signer, 'POST', '/admins', { npub }, signal);
}

export function removePanelAdmin(
  base: string,
  signer: PanelSigner,
  pubkey: string,
  signal?: AbortSignal,
): Promise<PanelAdminResult> {
  return call(base, signer, 'DELETE', `/admins/${pubkey}`, undefined, signal);
}
