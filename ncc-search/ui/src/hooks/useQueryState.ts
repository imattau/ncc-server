import { useCallback, useEffect, useState } from 'react';

// Keeps the search query in the URL (?q=...), like every real search
// engine does -- shareable/bookmarkable links, working back/forward. No
// router dependency needed for a one-page app; just the native History API.
function readQuery(): string {
  return new URLSearchParams(window.location.search).get('q') ?? '';
}

export function useQueryState() {
  const [query, setQueryState] = useState(readQuery);

  useEffect(() => {
    const onPopState = () => setQueryState(readQuery());
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  const setQuery = useCallback((next: string, options: { replace?: boolean } = {}) => {
    const url = new URL(window.location.href);
    if (next) {
      url.searchParams.set('q', next);
    } else {
      url.searchParams.delete('q');
    }
    if (options.replace) {
      window.history.replaceState({}, '', url);
    } else {
      window.history.pushState({}, '', url);
    }
    setQueryState(next);
  }, []);

  return [query, setQuery] as const;
}
