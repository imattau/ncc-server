import { useCallback, useState } from 'react';

const STORAGE_KEY = 'ncc-search:blur-nsfw';

function readStored(): boolean {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    // Blur by default, same reasoning as safe search: a first visit should
    // not flash publisher-tagged NSFW media before anyone has chosen.
    return value === null ? true : value === 'true';
  } catch {
    return true;
  }
}

/**
 * Whether images, videos and shorts carrying an NSFW/sensitive
 * `content-warning` label are blurred until clicked. Like safe search this is
 * purely a client-side display preference -- the backend only exposes what the
 * publisher tagged (see src/lib/nsfw.ts and src/adapters/media.js).
 */
export function useBlurNsfw() {
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
