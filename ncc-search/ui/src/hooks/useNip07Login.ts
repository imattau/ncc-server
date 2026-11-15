import { useCallback, useState } from 'react';
import { hasNip07 } from '@/lib/nip07';

const STORAGE_KEY = 'ncc-search:pubkey';

function readStoredPubkey(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    // Private browsing / storage disabled -- just means no persistence
    // across reloads, not a reason to break sign-in.
    return null;
  }
}

/**
 * NIP-07 sign-in: identifies which pubkey's follows/interests should
 * personalize ranking (see ../lib/ranking.ts). The pubkey itself is public
 * data, safe to persist in localStorage so a reload doesn't force
 * re-signing-in; nothing secret ever touches this app, since it never asks
 * for signEvent.
 *
 * Deliberately doesn't expose a synchronous "hasExtension" flag to gate the
 * sign-in button on: several NIP-07 extensions inject `window.nostr` a
 * moment after the page loads, not before, so checking at mount time can
 * report "no extension" for an extension that's actually there a few
 * milliseconds later. `login()` itself is the single source of truth --
 * it checks at the moment of the actual attempt and throws a clear error
 * if nothing answered.
 */
export function useNip07Login() {
  const [pubkey, setPubkey] = useState<string | null>(readStoredPubkey);

  const login = useCallback(async (): Promise<string> => {
    if (!hasNip07()) {
      throw new Error('No NIP-07 extension found (e.g. Alby, nos2x).');
    }
    const pk = await window.nostr!.getPublicKey();
    setPubkey(pk);
    try {
      localStorage.setItem(STORAGE_KEY, pk);
    } catch {
      // Non-fatal: the session still works, just won't survive a reload.
    }
    return pk;
  }, []);

  const logout = useCallback(() => {
    setPubkey(null);
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // Nothing to clean up if storage isn't available in the first place.
    }
  }, []);

  return { pubkey, login, logout };
}
