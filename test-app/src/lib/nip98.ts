/**
 * NIP-98 HTTP auth for the node admin API.
 *
 * The sidecar will not act on an unsigned request from the public listener, so
 * every admin call carries a kind 27235 event signed by the connected key. The
 * event is bound to the exact request URL and method, and the sidecar rejects
 * it after a minute or on a second use.
 */

export const NIP98_KIND = 27235;

export interface PanelSigner {
  signEvent(event: {
    kind: number;
    created_at: number;
    tags: string[][];
    content: string;
  }): Promise<unknown>;
}

function base64Utf8(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export type Nip98Method = 'GET' | 'POST' | 'DELETE';

/** Build the `Authorization` header for one admin API request. */
export async function nip98Authorization(
  signer: PanelSigner,
  url: string,
  method: Nip98Method,
): Promise<string> {
  const event = await signer.signEvent({
    kind: NIP98_KIND,
    created_at: Math.floor(Date.now() / 1000),
    tags: [['u', url], ['method', method]],
    content: '',
  });

  return `Nostr ${base64Utf8(JSON.stringify(event))}`;
}
