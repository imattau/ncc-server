import { nip19, verifyEvent, type Event } from 'nostr-tools';

import type { Nip07Signer } from './nip07';

// NIP-5A: a manifest is one addressable event listing every file by path and
// sha256, plus the Blossom servers that hold the bytes. ncc-browser (and any
// other NIP-5A client) fetches each file by hash and verifies it, so this page
// never needs to publish file *contents* to a relay -- only the index.
export const NAMED_SITE_KIND = 35128;
export const ROOT_SITE_KIND = 15128;

// ncc-browser's own site-id grammar (src/shared/nsite-url.ts): lowercase,
// digits and dashes, at most 13 characters, and not ending in a dash.
const SITE_ID_RE = /^[a-z0-9-]{1,13}$/;

export interface SiteFile {
  /** Absolute path, starting with `/` -- the manifest's addressing key. */
  path: string;
  hash: string;
  size: number;
  file: File;
}

export interface ManifestInput {
  siteId: string;
  title: string;
  description: string;
  source: string;
  files: SiteFile[];
  servers: string[];
  signer: Nip07Signer;
}

export interface RelayReport {
  relay: string;
  ok: boolean;
  message: string;
}

export function validateSiteId(siteId: string): string | null {
  if (!SITE_ID_RE.test(siteId)) {
    return 'Use 1-13 characters: lowercase letters, digits and dashes, not ending in a dash.';
  }
  if (siteId.endsWith('-')) return 'The site id cannot end with a dash.';
  return null;
}

/** Checks the folder is actually a built static site rather than any folder. */
export function validateFiles(files: SiteFile[]): string[] {
  const problems: string[] = [];
  if (files.length === 0) return ['Choose the built site folder first.'];
  if (!files.some((file) => file.path === '/index.html')) {
    problems.push('The folder has no /index.html at its root, so the site has no entry page.');
  }
  const seen = new Set<string>();
  for (const file of files) {
    if (!file.path.startsWith('/')) problems.push(`${file.path} is not an absolute path.`);
    if (file.path.includes('\0') || file.path.split('/').includes('..')) {
      problems.push(`${file.path} contains an illegal path segment.`);
    }
    if (seen.has(file.path)) problems.push(`${file.path} appears twice.`);
    seen.add(file.path);
    if (file.size > 25 * 1024 * 1024) problems.push(`${file.path} is larger than 25 MB.`);
  }
  return problems;
}

export async function signManifest(input: ManifestInput): Promise<Event> {
  const tags: string[][] = [
    ['d', input.siteId],
    ...(input.title.trim() ? [['title', input.title.trim()]] : []),
    ...(input.description.trim() ? [['description', input.description.trim()]] : []),
    ...(input.source.trim() ? [['source', input.source.trim()]] : []),
    ...input.files.map((file) => ['path', file.path, file.hash]),
    ...input.servers.map((server) => ['server', server.replace(/\/+$/, '')]),
  ];
  const event = await input.signer.signEvent({
    kind: NAMED_SITE_KIND,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content: '',
  });
  if (!verifyEvent(event)) throw new Error('The signer returned an invalid manifest signature.');
  return event;
}

export function nsiteAddress(pubkey: string, siteId: string): string | null {
  try {
    return `nsite://${nip19.npubEncode(pubkey)}/${siteId}`;
  } catch {
    return null;
  }
}

function publishToRelay(relay: string, event: Event, timeoutMs = 10_000): Promise<RelayReport> {
  return new Promise<RelayReport>((resolve) => {
    let settled = false;
    let socket: WebSocket | null = null;
    const finish = (ok: boolean, message: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket?.close();
      } catch {
        // already closed
      }
      resolve({ relay, ok, message });
    };
    const timer = setTimeout(() => finish(false, 'timed out'), timeoutMs);

    let ws: WebSocket;
    try {
      ws = new WebSocket(relay);
    } catch (error) {
      finish(false, error instanceof Error ? error.message : String(error));
      return;
    }
    socket = ws;

    ws.onopen = () => ws.send(JSON.stringify(['EVENT', event]));
    ws.onerror = () => finish(false, 'connection failed');
    ws.onclose = () => finish(false, 'closed before the relay acknowledged the event');
    ws.onmessage = (message) => {
      let payload: unknown;
      try {
        payload = JSON.parse(String(message.data));
      } catch {
        return;
      }
      if (!Array.isArray(payload) || payload[0] !== 'OK' || payload[1] !== event.id) return;
      finish(Boolean(payload[2]), String(payload[3] ?? ''));
    };
  });
}

export async function publishManifest(relays: string[], event: Event): Promise<RelayReport[]> {
  if (!verifyEvent(event)) throw new Error('Refusing to publish an invalid manifest.');
  return Promise.all(relays.map((relay) => publishToRelay(relay, event)));
}
