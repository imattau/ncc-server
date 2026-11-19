import { useEffect, useState } from 'react';
import { Pause, Play, Settings2 } from 'lucide-react';

import { useLocalCrawlStatus } from '@/hooks/useLocalCrawlStatus';
import {
  getLocalBootError,
  pauseLocalCrawl,
  resumeLocalCrawl,
} from '@/lib/local/client';
import { crawlActivity, formatBytes } from '@/lib/local/format';
import { cn } from '@/lib/utils';

// The nsite edition's status strip. It deliberately keeps only the two quick
// actions a reader needs while browsing (pause/resume) and hands every knob to
// the shared settings sheet; the old inline form was 11–12px with 20px buttons,
// which was unreadable on a phone. The sheet is the one settings surface both
// editions use, and it is sized for touch (see SettingsSheet.tsx).

const ACTION =
  'inline-flex min-h-11 items-center gap-1.5 rounded-md px-2.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none sm:min-h-0 sm:px-1.5 sm:py-0.5 sm:text-xs pointer-coarse:min-h-11 pointer-coarse:text-sm';

/**
 * The nsite edition's own status line: what this browser has crawled, from
 * which relays, and whether the crawl is still running. It exists because the
 * reader cannot otherwise tell "no results" from "not crawled yet" -- and
 * because a local index should never borrow the server's reassuring copy.
 */
export function LocalIndexPanel({
  className,
  onOpenSettings,
}: {
  className?: string;
  onOpenSettings: () => void;
}) {
  const status = useLocalCrawlStatus();
  const [stalled, setStalled] = useState(false);

  // A worker that fails to boot never posts a status, so without this the
  // panel would say "Starting…" forever with no explanation. The boot error
  // is usually all a reader needs ("IndexedDB unavailable", a bad relay list,
  // or a CSP block in the browser).
  useEffect(() => {
    if (status) return;
    const timer = setTimeout(() => setStalled(true), 20_000);
    return () => clearTimeout(timer);
  }, [status]);

  if (!status) {
    const bootError = getLocalBootError();
    return (
      <p className={cn('text-sm', bootError || stalled ? 'text-red-600 dark:text-red-400' : 'text-muted-foreground', className)} role="status">
        {bootError
          ? `The local index could not start: ${bootError}`
          : stalled
            ? 'The local index did not start. Reload the page to try again.'
            : 'Starting the local index…'}
      </p>
    );
  }

  const busy = status.phase === 'crawling' || status.phase === 'loading';
  const bytes = formatBytes(status.bytesStored);

  return (
    <div
      className={cn(
        'rounded-md border border-border bg-muted/30 px-3 py-2 text-sm text-muted-foreground sm:text-xs',
        className,
      )}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <span className="font-medium text-foreground">Local index</span>
          <span aria-hidden="true">·</span>
          <span>{status.recordCount.toLocaleString()} records</span>
          <span aria-hidden="true">·</span>
          <span>
            {status.relays.length} relay{status.relays.length === 1 ? '' : 's'}
          </span>
          <span aria-hidden="true">·</span>
          <span className={cn(busy && 'text-foreground')} role="status">
            {crawlActivity(status)}
          </span>
          {bytes && (
            <span className="hidden items-center gap-x-2 sm:flex">
              <span aria-hidden="true">·</span>
              <span>{bytes}</span>
            </span>
          )}
        </span>

        <span className="ml-auto flex items-center gap-0.5">
          {status.phase === 'paused' ? (
            <button type="button" className={ACTION} onClick={resumeLocalCrawl} title="Resume crawling">
              <Play className="size-4 sm:size-3" aria-hidden="true" />
              Resume
            </button>
          ) : (
            <button
              type="button"
              className={ACTION}
              onClick={pauseLocalCrawl}
              disabled={status.phase === 'loading'}
              title="Pause crawling"
            >
              <Pause className="size-4 sm:size-3" aria-hidden="true" />
              Pause
            </button>
          )}
          <button
            type="button"
            className={ACTION}
            onClick={onOpenSettings}
            title="Open settings"
          >
            <Settings2 className="size-4 sm:size-3" aria-hidden="true" />
            Settings
          </button>
        </span>
      </div>

      <p className="mt-1 hidden text-xs text-muted-foreground/80 sm:block">
        Crawled by this browser while the tab is open. Relay data only — endpoints are not fetched or
        verified here.
      </p>
    </div>
  );
}
