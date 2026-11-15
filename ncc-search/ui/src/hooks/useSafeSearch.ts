import { useCallback, useState } from 'react';

const STORAGE_KEY = 'ncc-search:safe-search';

function readStored(): boolean {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    // Safe by default, same convention every real search engine uses --
    // absence of a stored preference (first visit) means "on", not "off".
    return value === null ? true : value === 'true';
  } catch {
    return true;
  }
}

/**
 * Safe search: whether to hide results carrying a NIP-68/71
 * `content-warning` tag (see src/lib/api.ts's `contentWarning` field).
 * Purely a client-side display preference -- the backend makes no safety
 * judgment, it only exposes what the publisher tagged; see
 * src/adapters/media.js.
 */
export function useSafeSearch() {
  const [enabled, setEnabledState] = useState<boolean>(readStored);

  const setEnabled = useCallback((next: boolean) => {
    setEnabledState(next);
    try {
      localStorage.setItem(STORAGE_KEY, String(next));
    } catch {
      // Non-fatal: the toggle still works for this page view, just won't persist.
    }
  }, []);

  const toggle = useCallback(() => setEnabled(!enabled), [enabled, setEnabled]);

  return { enabled, setEnabled, toggle };
}
