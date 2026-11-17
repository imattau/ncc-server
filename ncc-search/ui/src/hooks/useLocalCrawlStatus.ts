import { useEffect, useState } from 'react';

import { getLocalStatus, subscribeLocalStatus } from '@/lib/local/client';
import type { LocalCrawlStatus } from '@/lib/local/types';

/**
 * Live crawl/index state for the nsite edition. Unlike useSearchStatus (which
 * polls the API), this is pushed by the worker as rows are added, so the
 * record count and activity line move with the crawl instead of lagging a
 * poll interval behind it.
 */
export function useLocalCrawlStatus(): LocalCrawlStatus | null {
  const [status, setStatus] = useState<LocalCrawlStatus | null>(getLocalStatus);
  useEffect(() => subscribeLocalStatus(setStatus), []);
  return status;
}
