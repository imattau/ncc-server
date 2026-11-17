import type { Nip07Signer } from './nip07';

// BUD-02 uploads from a page. Every blob is content-addressed, so the whole
// interaction is: hash locally, ask the signer to authorise exactly that hash,
// PUT the bytes. A server that answers "already have it" is a success.
const AUTH_KIND = 24242;
const AUTH_TTL_SECONDS = 600;

export async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function toBase64UrlUtf8(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  // Chunked so a long event cannot blow the argument limit of `fromCharCode`.
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  // BUD-11 requires base64url without padding for the Authorization header --
  // standard base64 is rejected by at least one large public server.
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const MIME_BY_EXTENSION: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json',
  webmanifest: 'application/manifest+json',
  txt: 'text/plain; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  avif: 'image/avif',
  gif: 'image/gif',
  ico: 'image/x-icon',
  wasm: 'application/wasm',
  woff: 'font/woff',
  woff2: 'font/woff2',
  mp4: 'video/mp4',
  webm: 'video/webm',
};

export function mimeFor(path: string): string {
  const extension = path.split('.').pop()?.toLowerCase() ?? '';
  return MIME_BY_EXTENSION[extension] ?? 'application/octet-stream';
}

export interface ServerOutcome {
  server: string;
  ok: boolean;
  message: string;
}

async function authHeader(hash: string, signer: Nip07Signer): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const event = await signer.signEvent({
    kind: AUTH_KIND,
    created_at: now,
    tags: [
      ['t', 'upload'],
      ['expiration', String(now + AUTH_TTL_SECONDS)],
      ['x', hash],
    ],
    content: 'Upload an nsite file',
  });
  return `Nostr ${toBase64UrlUtf8(JSON.stringify(event))}`;
}

export async function blobExists(server: string, hash: string): Promise<boolean> {
  try {
    const response = await fetch(`${server.replace(/\/+$/, '')}/${hash}`, { method: 'HEAD' });
    return response.ok;
  } catch {
    // HEAD is often the first thing a CORS configuration forgets; a failed
    // probe only means "try the upload", never "this server is broken".
    return false;
  }
}

/** Uploads one blob. `already-exists` is a success: the address is the hash. */
export async function uploadBlob(options: {
  server: string;
  hash: string;
  file: File;
  path: string;
  signer: Nip07Signer;
}): Promise<ServerOutcome> {
  const server = options.server.replace(/\/+$/, '');
  try {
    if (await blobExists(server, options.hash)) {
      return { server, ok: true, message: 'already stored' };
    }
    const authorization = await authHeader(options.hash, options.signer);
    // BUD-02 is `PUT /upload` with the hash in `x-sha-256`, not `PUT /<hash>`:
    // a server can store the bytes under an extension-suffixed URL, so the
    // request path is not the address. (This cost a round of 405s on
    // blossom.ditto.pub while building this page.)
    const response = await fetch(`${server}/upload`, {
      method: 'PUT',
      headers: {
        Authorization: authorization,
        'Content-Type': mimeFor(options.path),
        'X-Sha-256': options.hash,
      },
      body: options.file,
    });
    if (response.ok || response.status === 409) {
      return { server, ok: true, message: `uploaded (${response.status})` };
    }
    const reason = response.headers.get('x-reason');
    const detail = (reason ?? (await response.text().catch(() => ''))).replace(/\s+/g, ' ').slice(0, 160);
    return { server, ok: false, message: `HTTP ${response.status}${detail ? `: ${detail}` : ''}` };
  } catch (error) {
    return {
      server,
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Downloads a blob and checks its bytes against the manifest hash. */
export async function verifyBlob(server: string, hash: string): Promise<boolean> {
  try {
    const response = await fetch(`${server.replace(/\/+$/, '')}/${hash}`, { cache: 'no-store' });
    if (!response.ok) return false;
    const bytes = await response.arrayBuffer();
    return (await sha256Hex(bytes)) === hash;
  } catch {
    return false;
  }
}
