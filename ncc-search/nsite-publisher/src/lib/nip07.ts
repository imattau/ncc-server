// The subset of NIP-07 this page uses. It is deliberately tiny: the publisher
// never sees a private key, and a signer that can only return a pubkey and
// sign an event is all it needs.
import type { Event } from 'nostr-tools';

export interface Nip07Signer {
  getPublicKey(): Promise<string>;
  signEvent(event: {
    kind: number;
    created_at: number;
    tags: string[][];
    content: string;
  }): Promise<Event>;
}

declare global {
  interface Window {
    nostr?: Nip07Signer;
  }
}

export function detectSigner(): Nip07Signer | null {
  return typeof window !== 'undefined' && window.nostr ? window.nostr : null;
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'Something went wrong.';
}
