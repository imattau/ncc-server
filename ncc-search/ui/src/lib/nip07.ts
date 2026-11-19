// NIP-07 ("window.nostr capability for web browsers") -- the standard
// browser-extension signer interface (Alby, nos2x, etc.). This app only
// ever calls `getPublicKey()`: it never publishes anything, so it never
// asks for `signEvent` or either encryption capability, deliberately
// requesting the narrowest permission an extension can grant. Identifying
// who's using the browser is all personalized ranking needs (see
// ../lib/ranking.ts) -- it is not a login system with its own session,
// just "whose follows/interests should boost these results".

export interface Nip07Signer {
  getPublicKey(): Promise<string>;
}

declare global {
  interface Window {
    nostr?: Nip07Signer;
    NCC_SEARCH_PUBKEY?: string;
  }
}

export function hasNip07(): boolean {
  return typeof window !== 'undefined' && typeof window.nostr?.getPublicKey === 'function';
}
